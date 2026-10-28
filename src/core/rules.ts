import type { Db } from './store/db'
import type { MailStore, MessageRow } from './store/mailstore'
import type { MailRule, MailRuleInput, RuleAction, RuleField } from '../shared/ipc'

/**
 * Pravidlá pre novú poštu (ako „Pravidlá správ“ v Outlook Expresse): ak odosielateľ, adresát alebo predmet
 * obsahuje zadaný text, správa sa presunie, označí ako prečítaná, označí hviezdičkou, archivuje alebo dá do Koša.
 * Pravidlá sa vyhodnocujú v poradí; prvé pravidlo, ktoré správu presunie, ukončí vyhodnocovanie.
 * Pravidlá bežia len v Doare (nie na serveri) – na novú poštu v doručenej pošte a na požiadanie na priečinok.
 */

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const FIELDS: readonly RuleField[] = ['from', 'to', 'subject', 'any']
const ACTIONS: readonly RuleAction[] = ['move', 'read', 'flag', 'archive', 'trash']

interface RuleRow {
  id: number
  name: string
  enabled: number
  account_id: number | null
  field: RuleField
  value: string
  action: RuleAction
  folder_id: number | null
  position: number
}

function toRule(r: RuleRow): MailRule {
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    accountId: r.account_id,
    field: r.field,
    value: r.value,
    action: r.action,
    folderId: r.folder_id
  }
}

export function listRules(db: Db): MailRule[] {
  return (db.prepare('SELECT * FROM rules ORDER BY position, id').all() as unknown as RuleRow[]).map(toRule)
}

/** Uloží pravidlo (nové bez id). Overí konto a cieľový priečinok. */
export function saveRule(db: Db, input: MailRuleInput): MailRule {
  const field = FIELDS.includes(input?.field) ? input.field : null
  const action = ACTIONS.includes(input?.action) ? input.action : null
  const value = typeof input?.value === 'string' ? input.value.trim().slice(0, 500) : ''
  if (!field || !action) throw err('INVALID', 'Neplatné pravidlo')
  if (!value) throw err('RULE_EMPTY', 'Zadajte text, ktorý má správa obsahovať')
  let accountId = Number.isInteger(input.accountId) ? (input.accountId as number) : null
  if (accountId !== null && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw err('NOT_FOUND', 'Konto neexistuje')
  let folderId: number | null = null
  if (action === 'move') {
    const f = Number.isInteger(input.folderId)
      ? (db.prepare('SELECT id, account_id FROM folders WHERE id = ?').get(input.folderId as number) as { id: number; account_id: number } | undefined)
      : undefined
    if (!f) throw err('RULE_NO_FOLDER', 'Vyberte priečinok, kam sa majú správy presunúť')
    if (accountId !== null && accountId !== f.account_id) throw err('CROSS_ACCOUNT', 'Priečinok patrí inému kontu')
    // Presun je možný len v rámci konta – pravidlo s priečinkom platí pre jeho konto.
    accountId = f.account_id
    folderId = f.id
  }
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : ''
  const enabled = input.enabled === false ? 0 : 1
  if (Number.isInteger(input.id)) {
    const r = db
      .prepare('UPDATE rules SET name = ?, enabled = ?, account_id = ?, field = ?, value = ?, action = ?, folder_id = ? WHERE id = ? RETURNING *')
      .get(name, enabled, accountId, field, value, action, folderId, input.id as number) as unknown as RuleRow | undefined
    if (!r) throw err('NOT_FOUND', 'Pravidlo neexistuje')
    return toRule(r)
  }
  const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM rules').get() as { p: number }).p
  const r = db
    .prepare('INSERT INTO rules (name, enabled, account_id, field, value, action, folder_id, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .get(name, enabled, accountId, field, value, action, folderId, pos) as unknown as RuleRow
  return toRule(r)
}

export function deleteRule(db: Db, id: number): void {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id)
}

/** Nové poradie pravidiel (zoznam id v požadovanom poradí). */
export function reorderRules(db: Db, ids: number[]): void {
  const st = db.prepare('UPDATE rules SET position = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    ids.forEach((id, i) => st.run(i + 1, id))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Text bez diakritiky a veľkých písmen – „Šťastná“ nájde aj „stastna“. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

function addresses(json: string): string {
  try {
    return (JSON.parse(json) as { name?: string; address?: string }[]).map((a) => `${a.name ?? ''} <${a.address ?? ''}>`).join(', ')
  } catch {
    return ''
  }
}

function fieldText(m: MessageRow, field: RuleField): string {
  const from = `${m.from_name} <${m.from_addr}>`
  const to = `${addresses(m.to_json)}, ${addresses(m.cc_json)}`
  if (field === 'from') return from
  if (field === 'to') return to
  if (field === 'subject') return m.subject
  return `${from}\n${to}\n${m.subject}`
}

export function ruleMatches(rule: Pick<MailRule, 'field' | 'value' | 'accountId'>, m: MessageRow): boolean {
  if (rule.accountId !== null && rule.accountId !== m.account_id) return false
  const needle = fold(rule.value.trim())
  return !!needle && fold(fieldText(m, rule.field)).includes(needle)
}

export interface RuleActions {
  move(ids: number[], target: { folderId?: number; special?: 'trash' | 'archive' }): void
  setFlags(ids: number[], change: { seen?: boolean; flagged?: boolean }): void
}

/**
 * Použije pravidlá na správy. Vráti ID správ, ktoré pravidlá presunuli alebo označili ako prečítané
 * (o tých sa neoznamuje nová pošta), a počet správ, na ktoré sa niektoré pravidlo použilo.
 */
export function applyRules(
  db: Db,
  store: Pick<MailStore, 'message'>,
  actions: RuleActions,
  messageIds: number[],
  only?: MailRule[]
): { handled: Set<number>; applied: number } {
  const rules = (only ?? listRules(db)).filter((r) => r.enabled)
  const handled = new Set<number>()
  let applied = 0
  if (!rules.length || !messageIds.length) return { handled, applied }
  const moves = new Map<string, { target: { folderId?: number; special?: 'trash' | 'archive' }; ids: number[] }>()
  const read: number[] = []
  const flag: number[] = []
  for (const id of messageIds) {
    const m = store.message(id)
    if (!m) continue
    let matched = false
    for (const r of rules) {
      if (!ruleMatches(r, m)) continue
      matched = true
      if (r.action === 'read') {
        if (!m.seen) read.push(id)
        handled.add(id)
        continue
      }
      if (r.action === 'flag') {
        if (!m.flagged) flag.push(id)
        continue
      }
      // Presun (aj do Archívu a Koša) ukončí vyhodnocovanie ďalších pravidiel.
      if (r.action === 'move' && r.folderId === m.folder_id) break
      const target = r.action === 'move' ? { folderId: r.folderId! } : { special: r.action }
      const key = JSON.stringify(target)
      const g = moves.get(key) ?? { target, ids: [] }
      g.ids.push(id)
      moves.set(key, g)
      handled.add(id)
      break
    }
    if (matched) applied++
  }
  if (read.length) actions.setFlags(read, { seen: true })
  if (flag.length) actions.setFlags(flag, { flagged: true })
  for (const g of moves.values()) {
    try {
      actions.move(g.ids, g.target)
    } catch {
      // Cieľ medzičasom zmizol a pod. – správy ostanú, kde sú.
      for (const id of g.ids) handled.delete(id)
    }
  }
  return { handled, applied }
}
