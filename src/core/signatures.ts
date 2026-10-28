import { stat, readFile } from 'node:fs/promises'
import type { Db } from './store/db'
import type { FileGrants } from './files'
import type { Signature, SignatureInput } from '../shared/ipc'
import { htmlToText, sanitizeComposeHtml } from './mail/outgoing-html'

/**
 * Podpisy: viac na konto, formátované (tučné, odkazy, logo). Jeden môže byť predvolený – vloží sa do novej správy;
 * v okne správy sa dá vybrať iný alebo žiadny.
 */

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

interface Row {
  id: number
  account_id: number
  name: string
  html: string
  is_default: number
}

const toSignature = (r: Row): Signature => ({ id: r.id, accountId: r.account_id, name: r.name, html: r.html, text: htmlToText(r.html), isDefault: !!r.is_default })

export function listSignatures(db: Db, accountId?: number): Signature[] {
  const rows = (accountId === undefined
    ? db.prepare('SELECT * FROM signatures ORDER BY account_id, position, id').all()
    : db.prepare('SELECT * FROM signatures WHERE account_id = ? ORDER BY position, id').all(accountId)) as unknown as Row[]
  return rows.map(toSignature)
}

/** Predvolený podpis konta ako text (čistý text správy, AI…). */
export function defaultSignatureText(db: Db, accountId: number): string {
  const r = db.prepare('SELECT * FROM signatures WHERE account_id = ? AND is_default = 1 LIMIT 1').get(accountId) as unknown as Row | undefined
  return r ? htmlToText(r.html).trim() : ''
}

export function saveSignature(db: Db, input: SignatureInput): Signature {
  const accountId = Number(input?.accountId)
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw err('NOT_FOUND', 'Konto neexistuje')
  const html = sanitizeComposeHtml(typeof input.html === 'string' ? input.html : '')
  if (!htmlToText(html).trim() && !/<img\b/i.test(html)) throw err('SIGNATURE_EMPTY', 'Podpis je prázdny')
  if (html.length > 1_500_000) throw err('SIGNATURE_TOO_BIG', 'Podpis je príliš veľký (zmenšite logo)')
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : ''
  db.exec('BEGIN')
  try {
    let id: number
    if (Number.isInteger(input.id)) {
      const cur = db.prepare('SELECT account_id FROM signatures WHERE id = ?').get(input.id as number) as { account_id: number } | undefined
      if (!cur || cur.account_id !== accountId) throw err('NOT_FOUND', 'Podpis neexistuje')
      db.prepare('UPDATE signatures SET name = ?, html = ? WHERE id = ?').run(name, html, input.id as number)
      id = input.id as number
    } else {
      const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM signatures WHERE account_id = ?').get(accountId) as { p: number }).p
      const first = !db.prepare('SELECT 1 FROM signatures WHERE account_id = ?').get(accountId)
      id = (db.prepare('INSERT INTO signatures (account_id, name, html, is_default, position) VALUES (?, ?, ?, ?, ?) RETURNING id').get(accountId, name, html, first ? 1 : 0, pos) as { id: number }).id
    }
    if (input.isDefault === true) setDefault(db, accountId, id)
    else if (input.isDefault === false) db.prepare('UPDATE signatures SET is_default = 0 WHERE id = ?').run(id)
    db.exec('COMMIT')
    return toSignature(db.prepare('SELECT * FROM signatures WHERE id = ?').get(id) as unknown as Row)
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function setDefault(db: Db, accountId: number, id: number | null): void {
  db.prepare('UPDATE signatures SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE account_id = ?').run(id ?? -1, accountId)
}

/** Predvolený podpis konta (null = do nových správ žiadny). */
export function setDefaultSignature(db: Db, accountId: number, id: number | null): void {
  if (id !== null && !db.prepare('SELECT 1 FROM signatures WHERE id = ? AND account_id = ?').get(id, accountId)) throw err('NOT_FOUND', 'Podpis neexistuje')
  setDefault(db, accountId, id)
}

export function deleteSignature(db: Db, id: number): void {
  db.prepare('DELETE FROM signatures WHERE id = ?').run(id)
}

/** Textový podpis zo starších nastavení (patch konta) → predvolený podpis. Prázdny text predvolený podpis zmaže. */
export function setSignatureText(db: Db, accountId: number, text: string): void {
  const t = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  const cur = db.prepare('SELECT id FROM signatures WHERE account_id = ? AND is_default = 1 LIMIT 1').get(accountId) as { id: number } | undefined
  if (!t) {
    if (cur) deleteSignature(db, cur.id)
    return
  }
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  saveSignature(db, { id: cur?.id, accountId, name: '', html: `<p>${t.split('\n').map(esc).join('<br>')}</p>`, isDefault: true })
}

const IMAGE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/** Obrázok (logo) zo súboru vybraného v dialógu → data: URI na vloženie do podpisu. */
export async function readSignatureImage(files: FileGrants, path: string): Promise<{ dataUrl: string }> {
  const p = await files.require(path, 'read')
  const type = IMAGE[(p.split('.').pop() ?? '').toLowerCase()]
  if (!type) throw err('IMAGE_TYPE', 'Logo musí byť obrázok PNG, JPG, GIF alebo WebP')
  const st = await stat(p).catch(() => null)
  if (!st?.isFile()) throw err('FILE_MISSING', 'Súbor sa nenašiel')
  if (st.size > 500 * 1024) throw err('IMAGE_TOO_BIG', 'Logo je príliš veľké (najviac 500 kB)')
  return { dataUrl: `data:${type};base64,${(await readFile(p)).toString('base64')}` }
}
