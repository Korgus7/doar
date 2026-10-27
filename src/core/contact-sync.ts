import { randomUUID } from 'node:crypto'
import type { Db } from './store/db'
import type { ContactSyncStatus, CoreEvents, EventChannel } from '../shared/ipc'
import { CardDavClient, type DavCard, type DavFetch } from './carddav'
import { escapeV, foldLine, isEmail, parseVcards, splitName, type ParsedContact } from './contacts'
import { logger } from './log'

const log = logger('contacts')

/**
 * Synchronizácia adresára s kontaktmi Google (CardDAV), oboma smermi:
 * - stiahne zmeny zo servera (sync-token; pri prvom spustení alebo neplatnom tokene celý zoznam),
 * - odošle zmeny z Doaru (upravené, nové, zmazané),
 * - prepojený kontakt si pamätá pôvodný vCard – pri zmene sa prepíšu len polia, ktoré používateľ zmenil
 *   (fotky, narodeniny, ďalšie adresy a čísla na serveri ostanú).
 * Kontakty bez e-mailovej adresy na serveri Doar nesťahuje (adresár je e-mailový) a nemení ich.
 * Pri súbežnej zmene v Doare aj v mobile vyhrá zmena z Doaru pre polia, ktoré používateľ v Doare zmenil.
 */

const GOOGLE_CARDDAV = 'https://www.googleapis.com/.well-known/carddav'
const PERIODIC_MS = 15 * 60_000
const AFTER_CHANGE_MS = 5_000

type Row = {
  id: number
  name: string
  email: string
  phone: string
  company: string
  note: string
  address: string
  sync_account: number | null
  remote_href: string | null
  remote_etag: string | null
  remote_vcard: string | null
  dirty: number
  updated_at: string
}
const COLS = 'id, name, email, phone, company, note, address, sync_account, remote_href, remote_etag, remote_vcard, dirty, updated_at'

export interface ContactSyncDeps {
  db: Db
  emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
  /** Prístupový token konta (OAuth). */
  token(accountId: number): Promise<string>
  /** Pri odmietnutí tokenu (401) – nabudúce ho obnoviť. */
  invalidate?(accountId: number): void
  /** Úvodná adresa (.well-known) pre konto; predvolene Google. */
  discoveryUrl?(accountId: number): string
  fetch?: DavFetch
}

export interface SyncResult {
  downloaded: number
  uploaded: number
  removed: number
  /** Pri načítaní celého zoznamu: počet kontaktov na serveri a z nich bez e-mailu (tie Doar nesťahuje). */
  onServer: number | null
  withoutEmail: number
}

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const fieldsOf = (p: ParsedContact): { name: string; phone: string; company: string; note: string; address: string } => ({
  name: p.name.slice(0, 300),
  phone: p.phone.slice(0, 200),
  company: p.company.slice(0, 300),
  note: p.note.slice(0, 5000),
  address: p.address.slice(0, 1000)
})

/* ---------------- úprava vCard ---------------- */

function unfold(raw: string): string[] {
  const out: string[] = []
  for (const l of raw.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^[ \t]/.test(l) && out.length) out[out.length - 1] += l.slice(1)
    else out.push(l)
  }
  return out
}

/** Meno vlastnosti riadku (bez skupiny „item1.“), veľkými písmenami. */
function propName(line: string): string {
  const m = /^([^:;]+)/.exec(line)
  return (m?.[1] ?? '').replace(/^.*\./, '').toUpperCase()
}

/** Časť riadku pred hodnotou (skupina, meno, parametre) – hodnota začína za prvou dvojbodkou mimo úvodzoviek. */
function headOf(line: string): string {
  let q = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q
    else if (line[i] === ':' && !q) return line.slice(0, i)
  }
  return line
}

/** Nový vCard 3.0 pre kontakt z Doaru. */
export function newVcard(c: { name: string; email: string; phone: string; company: string; note: string; address: string }, uid: string): string {
  const { given, family } = splitName(c.name)
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${escapeV(c.name || c.email || c.phone)}`, `N:${escapeV(family)};${escapeV(given)};;;`]
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${c.email}`)
  for (const t of splitPhones(c.phone)) lines.push(`TEL:${escapeV(t)}`)
  if (c.company) lines.push(`ORG:${escapeV(c.company)}`)
  if (c.address) lines.push(`ADR;TYPE=HOME:;;${escapeV(c.address)};;;;`)
  if (c.note) lines.push(`NOTE:${escapeV(c.note)}`)
  lines.push('END:VCARD')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

const splitPhones = (s: string): string[] => s.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean)

/**
 * Prepíše v pôvodnom vCard len polia, ktoré sa v Doare zmenili; ostatné riadky ostanú bez zmeny.
 */
export function patchVcard(raw: string, c: { name: string; email: string; phone: string; company: string; note: string; address: string }): string {
  const before = parseVcards(raw)[0]
  let lines = unfold(raw).filter((l) => l !== '')
  const end = (): number => {
    const i = lines.findIndex((l) => /^END:VCARD$/i.test(l.trim()))
    return i < 0 ? lines.length : i
  }
  const replaceFirst = (prop: string, value: string | null, fallbackHead: string): void => {
    const i = lines.findIndex((l) => propName(l) === prop)
    if (value === null) {
      if (i >= 0) lines.splice(i, 1)
      return
    }
    if (i >= 0) lines[i] = `${headOf(lines[i]!)}:${value}`
    else lines.splice(end(), 0, `${fallbackHead}:${value}`)
  }
  if (!before || before.name !== c.name) {
    const { given, family } = splitName(c.name)
    replaceFirst('FN', escapeV(c.name || c.email || c.phone), 'FN')
    replaceFirst('N', `${escapeV(family)};${escapeV(given)};;;`, 'N')
  }
  if (!before || (before.emails[0] ?? '').toLowerCase() !== c.email.toLowerCase()) replaceFirst('EMAIL', c.email || null, 'EMAIL;TYPE=INTERNET')
  if (!before || before.phone !== c.phone) {
    const phones = splitPhones(c.phone)
    const heads = lines.filter((l) => propName(l) === 'TEL').map(headOf)
    lines = lines.filter((l) => propName(l) !== 'TEL')
    const at = end()
    lines.splice(at, 0, ...phones.map((p, i) => `${heads[i] ?? 'TEL'}:${escapeV(p)}`))
  }
  if (!before || before.company !== c.company) replaceFirst('ORG', c.company ? escapeV(c.company) : null, 'ORG')
  if (!before || before.address !== c.address) replaceFirst('ADR', c.address ? `;;${escapeV(c.address)};;;;` : null, 'ADR;TYPE=HOME')
  if (!before || before.note !== c.note) replaceFirst('NOTE', c.note ? escapeV(c.note) : null, 'NOTE')
  // REV: kedy sa kontakt naposledy zmenil (niektoré mobily podľa neho riešia súbežné zmeny).
  replaceFirst('REV', new Date().toISOString().replace(/\.\d{3}/, ''), 'REV')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

type Fields = { name: string; email: string; phone: string; company: string; note: string; address: string }
const KEYS = ['name', 'email', 'phone', 'company', 'note', 'address'] as const

/**
 * Trojcestné zlúčenie: čo používateľ v Doare zmenil oproti poslednej spoločnej verzii (base), ostane;
 * ostatné polia sa prevezmú z novej verzie zo servera.
 */
export function merge3(local: Fields, base: string | null, remote: string): Fields {
  const pb = base ? parseVcards(base)[0] : undefined
  const pr = parseVcards(remote)[0]
  if (!pr) return local
  const b = pb ? { ...fieldsOf(pb), email: pb.emails.find(isEmail) ?? '' } : null
  const r = { ...fieldsOf(pr), email: pr.emails.find(isEmail) ?? '' }
  const out = { ...local }
  for (const k of KEYS) if (b && local[k] === b[k]) out[k] = r[k]
  return out
}

/* ---------------- služba ---------------- */

export class ContactSync {
  private running: Promise<SyncResult> | null = null
  private timer: NodeJS.Timeout | null = null
  private soon: NodeJS.Timeout | null = null

  constructor(private readonly deps: ContactSyncDeps) {}

  private get db(): Db {
    return this.deps.db
  }

  /** Konto, s ktorým sa adresár synchronizuje (najviac jedno). */
  enabledAccount(): number | null {
    const r = this.db.prepare('SELECT account_id FROM contact_sync LIMIT 1').get() as { account_id: number } | undefined
    return r?.account_id ?? null
  }

  status(): ContactSyncStatus {
    const candidates = this.db
      .prepare(`SELECT id AS accountId, email FROM accounts WHERE auth_type = 'oauth2' AND provider_key = 'gmail' ORDER BY id`)
      .all() as unknown as { accountId: number; email: string }[]
    const s = this.db
      .prepare('SELECT s.account_id AS accountId, a.email, s.last_sync AS lastSync, s.last_error AS lastError FROM contact_sync s JOIN accounts a ON a.id = s.account_id LIMIT 1')
      .get() as { accountId: number; email: string; lastSync: string | null; lastError: string | null } | undefined
    const localOnly = (this.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE remote_href IS NULL OR sync_account IS NULL').get() as { n: number }).n
    return { candidates, enabled: s ? { ...s, running: !!this.running } : null, localOnly }
  }

  enable(accountId: number): void {
    const ok = this.db.prepare(`SELECT 1 FROM accounts WHERE id = ? AND auth_type = 'oauth2' AND provider_key = 'gmail'`).get(accountId)
    if (!ok) throw err('CONTACTS_ACCOUNT', 'Synchronizovať sa dá len s kontom Google prihláseným cez Google')
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM contact_sync').run()
      this.db.prepare('INSERT INTO contact_sync (account_id) VALUES (?)').run(accountId)
      // Prepojenia na iné konto neplatia – kontakty sa priradia znova podľa e-mailu.
      this.db.prepare('UPDATE contacts SET sync_account = NULL, remote_href = NULL, remote_etag = NULL, remote_vcard = NULL, dirty = 0 WHERE sync_account IS NOT ? ').run(accountId)
      this.db.prepare('DELETE FROM contact_tombstones WHERE account_id != ?').run(accountId)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    this.schedule()
  }

  /** Vypne synchronizáciu. Kontakty v Doare aj na serveri ostanú; prepojenia sa zabudnú. */
  disable(): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM contact_sync').run()
      this.db.prepare('UPDATE contacts SET sync_account = NULL, remote_href = NULL, remote_etag = NULL, remote_vcard = NULL, dirty = 0').run()
      this.db.prepare('DELETE FROM contact_tombstones').run()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    this.stop()
    this.deps.emit('contacts.changed', null)
  }

  /** Pravidelná synchronizácia (ak je zapnutá). */
  schedule(): void {
    this.stop()
    if (this.enabledAccount() === null) return
    this.timer = setInterval(() => void this.syncNow().catch(() => {}), PERIODIC_MS)
    this.timer.unref?.()
    setTimeout(() => void this.syncNow().catch(() => {}), 2_000).unref?.()
  }

  /** Po zmene v adresári – o chvíľu odoslať (viac zmien naraz = jedna synchronizácia). */
  changed(): void {
    if (this.enabledAccount() === null) return
    if (this.soon) clearTimeout(this.soon)
    this.soon = setTimeout(() => void this.syncNow().catch(() => {}), AFTER_CHANGE_MS)
    this.soon.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.timer = null
    this.soon = null
  }

  syncNow(): Promise<SyncResult> {
    if (this.running) return this.running
    const accountId = this.enabledAccount()
    if (accountId === null) return Promise.reject(err('CONTACTS_SYNC_OFF', 'Synchronizácia adresára nie je zapnutá'))
    this.running = this.run(accountId)
      .then((r) => {
        this.db.prepare(`UPDATE contact_sync SET last_sync = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error = NULL WHERE account_id = ?`).run(accountId)
        log.info('adresár zosynchronizovaný', { account: accountId, ...r })
        return r
      })
      .catch((e: { code?: string }) => {
        const code = e.code ?? 'UNKNOWN'
        this.db.prepare('UPDATE contact_sync SET last_error = ? WHERE account_id = ?').run(code, accountId)
        if (code === 'CONTACTS_PERMISSION') this.deps.invalidate?.(accountId)
        log.warn('synchronizácia adresára zlyhala', { account: accountId, code })
        throw e
      })
      .finally(() => {
        this.running = null
        this.deps.emit('contacts.changed', null)
      })
    this.deps.emit('contacts.changed', null)
    return this.running
  }

  private async run(accountId: number): Promise<SyncResult> {
    const client = new CardDavClient(() => this.deps.token(accountId), this.deps.fetch)
    const state = this.db.prepare('SELECT collection_url, sync_token FROM contact_sync WHERE account_id = ?').get(accountId) as
      | { collection_url: string | null; sync_token: string | null }
      | undefined
    if (!state) throw err('CONTACTS_SYNC_OFF', 'Synchronizácia adresára nie je zapnutá')
    let collection = state.collection_url
    if (!collection) {
      collection = await client.discover(this.deps.discoveryUrl?.(accountId) ?? GOOGLE_CARDDAV)
      this.db.prepare('UPDATE contact_sync SET collection_url = ? WHERE account_id = ?').run(collection, accountId)
    }
    const result: SyncResult = { downloaded: 0, uploaded: 0, removed: 0, onServer: null, withoutEmail: 0 }
    const token = await this.pull(client, accountId, collection, state.sync_token, result)
    await this.push(client, accountId, collection, result)
    if (token !== undefined) this.db.prepare('UPDATE contact_sync SET sync_token = ? WHERE account_id = ?').run(token, accountId)
    return result
  }

  private linked(accountId: number): Map<string, Row> {
    const rows = this.db.prepare(`SELECT ${COLS} FROM contacts WHERE sync_account = ? AND remote_href IS NOT NULL`).all(accountId) as unknown as Row[]
    return new Map(rows.map((r) => [r.remote_href!, r]))
  }

  /** Stiahne zmeny. Vráti nový sync-token (undefined = nemeniť). */
  private async pull(client: CardDavClient, accountId: number, collection: string, syncToken: string | null, result: SyncResult): Promise<string | null | undefined> {
    const local = this.linked(accountId)
    let changed: Map<string, string | null>
    let removed: string[]
    let token: string | null | undefined
    try {
      if (!syncToken) throw err('SYNC_TOKEN_INVALID', 'Prvá synchronizácia')
      const r = await client.syncCollection(collection, syncToken)
      changed = r.changed
      removed = r.removed
      token = r.token
    } catch (e) {
      if ((e as { code?: string }).code !== 'SYNC_TOKEN_INVALID') throw e
      // Celý zoznam: porovnať ETagy, čo na serveri chýba, bolo zmazané.
      const all = await client.listEtags(collection)
      result.onServer = all.size
      changed = new Map([...all].filter(([href, etag]) => !local.has(href) || !etag || local.get(href)!.remote_etag !== etag))
      removed = [...local.keys()].filter((h) => !all.has(h))
      token = await client.syncToken(collection).catch(() => null)
    }
    // Vlastné zmeny, ktoré sme práve odoslali, majú už známy ETag – nesťahovať znova.
    const hrefs = [...changed].filter(([href, etag]) => !(etag && local.get(href)?.remote_etag === etag)).map(([href]) => href)
    const cards = hrefs.length ? await client.fetchCards(collection, hrefs) : []
    for (const card of cards) {
      if (!parseVcards(card.vcard)[0]?.emails.some(isEmail)) result.withoutEmail++
      result.downloaded += this.applyRemote(accountId, card) ? 1 : 0
    }
    log.info('kontakty zo servera', { requested: hrefs.length, received: cards.length, withoutEmail: result.withoutEmail, full: result.onServer !== null })
    for (const href of removed) {
      const row = local.get(href)
      if (!row) continue
      // Zmenený v Doare a zmazaný v mobile → ponechať a nahrať ako nový.
      if (row.dirty) this.db.prepare('UPDATE contacts SET remote_href = NULL, remote_etag = NULL, remote_vcard = NULL, dirty = 0 WHERE id = ?').run(row.id)
      else {
        this.db.prepare('DELETE FROM contacts WHERE id = ?').run(row.id)
        result.removed++
      }
    }
    return token
  }

  /** Zapracuje kontakt zo servera. true = v Doare sa niečo zmenilo. */
  private applyRemote(accountId: number, card: DavCard): boolean {
    const p = parseVcards(card.vcard)[0]
    const email = p?.emails.find(isEmail) ?? ''
    const byHref = this.db.prepare(`SELECT ${COLS} FROM contacts WHERE sync_account = ? AND remote_href = ?`).get(accountId, card.href) as Row | undefined
    if (!p) return false
    const f = fieldsOf(p)
    // Úplne prázdny kontakt (bez mena, e-mailu, telefónu aj firmy) Doar nepreberá.
    if (!byHref && !email && !f.name && !f.phone && !f.company) return false
    const taken = (e: string, id: number): boolean => !!e && !!this.db.prepare('SELECT 1 FROM contacts WHERE email = ? AND id != ?').get(e, id)
    if (byHref) {
      if (byHref.dirty) {
        // Zmenený aj v Doare: polia zmenené v Doare ostanú (odošlú sa), ostatné sa prevezmú zo servera.
        const m = merge3(byHref, byHref.remote_vcard, card.vcard)
        this.db
          .prepare('UPDATE contacts SET name = ?, email = ?, phone = ?, company = ?, note = ?, address = ?, remote_etag = ?, remote_vcard = ? WHERE id = ?')
          .run(m.name, taken(m.email, byHref.id) ? byHref.email : m.email, m.phone, m.company, m.note, m.address, card.etag, card.vcard, byHref.id)
        return true
      }
      const clash = taken(email, byHref.id)
      this.db
        .prepare('UPDATE contacts SET name = ?, email = ?, phone = ?, company = ?, note = ?, address = ?, remote_etag = ?, remote_vcard = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?')
        .run(f.name, clash ? byHref.email : email, f.phone, f.company, f.note, f.address, card.etag, card.vcard, byHref.id)
      return true
    }
    // Rovnaký kontakt už v Doare: podľa e-mailu, bez e-mailu podľa mena a telefónu (len ešte neprepojený).
    const byEmail = (
      email
        ? this.db.prepare(`SELECT ${COLS} FROM contacts WHERE email = ?`).get(email)
        : this.db.prepare(`SELECT ${COLS} FROM contacts WHERE email = '' AND name = ? AND phone = ? AND (remote_href IS NULL OR sync_account IS NULL)`).get(f.name, f.phone)
    ) as Row | undefined
    if (byEmail) {
      if (byEmail.sync_account === accountId && byEmail.remote_href) return false // duplicita na serveri – ponechať prvý
      // Rovnaký e-mail už v Doare (import, ručne): prepojiť, doplniť prázdne polia; čo má len Doar, odošle sa.
      const merged = {
        name: byEmail.name || f.name,
        phone: byEmail.phone || f.phone,
        company: byEmail.company || f.company,
        note: byEmail.note || f.note,
        address: byEmail.address || f.address
      }
      const localHasMore = (Object.keys(merged) as (keyof typeof merged)[]).some((k) => merged[k] !== f[k])
      this.db
        .prepare('UPDATE contacts SET name = ?, phone = ?, company = ?, note = ?, address = ?, sync_account = ?, remote_href = ?, remote_etag = ?, remote_vcard = ?, dirty = ? WHERE id = ?')
        .run(merged.name, merged.phone, merged.company, merged.note, merged.address, accountId, card.href, card.etag, card.vcard, localHasMore ? 1 : 0, byEmail.id)
      return true
    }
    this.db
      .prepare('INSERT INTO contacts (name, email, phone, company, note, address, sync_account, remote_href, remote_etag, remote_vcard) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.name, email, f.phone, f.company, f.note, f.address, accountId, card.href, card.etag, card.vcard)
    return true
  }

  /** Odošle zmeny z Doaru: zmazané, upravené, nové. */
  private async push(client: CardDavClient, accountId: number, collection: string, result: SyncResult): Promise<void> {
    const tombs = this.db.prepare('SELECT id, href, etag FROM contact_tombstones WHERE account_id = ?').all(accountId) as { id: number; href: string; etag: string | null }[]
    for (const t of tombs) {
      try {
        await client.remove(t.href, t.etag)
      } catch (e) {
        // Medzitým zmenený v mobile: zmazanie v Doare má prednosť, zmazať bez podmienky.
        if ((e as { code?: string }).code !== 'CONFLICT') throw e
        await client.remove(t.href, null)
      }
      this.db.prepare('DELETE FROM contact_tombstones WHERE id = ?').run(t.id)
      result.uploaded++
    }

    const dirty = this.db.prepare(`SELECT ${COLS} FROM contacts WHERE sync_account = ? AND remote_href IS NOT NULL AND dirty = 1`).all(accountId) as unknown as Row[]
    // Ak používateľ kontakt medzitým znova zmenil (iný updated_at), ostane označený na ďalšie odoslanie.
    const link = this.db.prepare(
      'UPDATE contacts SET sync_account = ?, remote_href = ?, remote_etag = ?, remote_vcard = ?, dirty = CASE WHEN updated_at = ? THEN 0 ELSE 1 END WHERE id = ?'
    )
    for (const row of dirty) {
      let vcard = row.remote_vcard ? patchVcard(row.remote_vcard, row) : newVcard(row, randomUUID())
      let saved: { href: string; etag: string | null }
      try {
        saved = await client.put(row.remote_href!, vcard, row.remote_etag)
      } catch (e) {
        if ((e as { code?: string }).code !== 'CONFLICT') throw e
        const current = await client.get(row.remote_href!)
        if (!current) {
          // Na serveri ho medzitým zmazali → nahrať ako nový (nižšie).
          this.db.prepare('UPDATE contacts SET remote_href = NULL, remote_etag = NULL, remote_vcard = NULL, dirty = 0 WHERE id = ?').run(row.id)
          continue
        }
        const m = merge3(row, row.remote_vcard, current.vcard)
        this.db.prepare('UPDATE contacts SET name = ?, phone = ?, company = ?, note = ?, address = ? WHERE id = ?').run(m.name, m.phone, m.company, m.note, m.address, row.id)
        vcard = patchVcard(current.vcard, { ...m, email: row.email })
        saved = await client.put(row.remote_href!, vcard, current.etag)
      }
      link.run(accountId, saved.href, saved.etag, vcard, row.updated_at, row.id)
      result.uploaded++
    }

    const fresh = this.db.prepare(`SELECT ${COLS} FROM contacts WHERE remote_href IS NULL OR sync_account IS NULL OR sync_account != ?`).all(accountId) as unknown as Row[]
    const base = collection.endsWith('/') ? collection : `${collection}/`
    for (const row of fresh) {
      const uid = randomUUID()
      const vcard = newVcard(row, uid)
      const saved = await client.put(new URL(`${uid}.vcf`, base).toString(), vcard, null)
      link.run(accountId, saved.href, saved.etag, vcard, row.updated_at, row.id)
      result.uploaded++
    }
  }
}
