import type { Db } from './store/db'
import type { Address, Contact, ContactGroup, ContactInput, MailAddressItem } from '../shared/ipc'

/**
 * Adresár: kontakty uložené používateľom alebo importované (vCard .vcf, CSV z Outlooku, Gmailu, Excelu).
 * Kontakt má najviac jednu e-mailovú adresu (aj žiadnu – len telefón či adresu). Ďalšie adresy toho istého
 * človeka z importu sú samostatné kontakty s rovnakým menom (nič sa nestratí).
 */

const MAX = { name: 300, email: 320, phone: 200, company: 300, note: 5000, address: 1000 }
const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, n) : '')
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
export const isEmail = (s: string): boolean => s.length <= MAX.email && EMAIL.test(s)

type Row = { id: number; name: string; email: string; phone: string; company: string; note: string; address: string }
const COLS = 'id, name, email, phone, company, note, address'

const sortKey = (c: Row): string => fold(c.name || c.email || c.phone)

export function listContacts(db: Db, query = ''): Contact[] {
  const rows = db.prepare(`SELECT ${COLS} FROM contacts`).all() as unknown as Row[]
  const q = fold(query.trim())
  const hit = (c: Row): boolean => !q || [c.name, c.email, c.company, c.phone, c.address].some((v) => fold(v).includes(q))
  return rows.filter(hit).sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.email.localeCompare(b.email))
}

/** Ľudia, s ktorými si používateľ písal (adresáti odoslanej pošty), a ešte nie sú v adresári. */
export function mailAddresses(db: Db, query = '', limit = 500): MailAddressItem[] {
  const rows = db
    .prepare(
      `SELECT a.email, a.name, a.use_count AS count FROM addresses a
       WHERE a.use_count > 0 AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.email = a.email)
       ORDER BY a.use_count DESC, a.last_used DESC LIMIT 5000`
    )
    .all() as unknown as MailAddressItem[]
  const q = fold(query.trim())
  return rows.filter((r) => !q || fold(r.name).includes(q) || fold(r.email).includes(q)).slice(0, limit)
}

function validate(input: ContactInput | null | undefined): Omit<Row, 'id'> {
  const email = clip(input?.email, MAX.email).replace(/^mailto:/i, '')
  if (email && !isEmail(email)) throw err('INVALID_EMAIL', 'Neplatná e-mailová adresa')
  const c = {
    name: clip(input?.name, MAX.name).replace(/\s+/g, ' '),
    email,
    phone: clip(input?.phone, MAX.phone).replace(/\s+/g, ' '),
    company: clip(input?.company, MAX.company).replace(/\s+/g, ' '),
    note: clip(input?.note, MAX.note),
    address: clip(input?.address, MAX.address)
  }
  if (!c.name && !c.email && !c.phone && !c.company) throw err('CONTACT_EMPTY', 'Vyplňte aspoň meno, e-mail alebo telefón')
  return c
}

export function saveContact(db: Db, input: ContactInput): Contact {
  const c = validate(input)
  const id = Number.isInteger(input?.id) ? (input.id as number) : null
  const clash = c.email ? (db.prepare('SELECT id FROM contacts WHERE email = ?').get(c.email) as { id: number } | undefined) : undefined
  if (clash && clash.id !== id) throw err('CONTACT_EXISTS', 'Kontakt s touto adresou už v adresári je')
  if (id !== null) {
    const r = db
      .prepare(
        `UPDATE contacts SET name = ?, email = ?, phone = ?, company = ?, note = ?, address = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           dirty = CASE WHEN remote_href IS NOT NULL THEN 1 ELSE dirty END WHERE id = ?`
      )
      .run(c.name, c.email, c.phone, c.company, c.note, c.address, id)
    if (!r.changes) throw err('NOT_FOUND', 'Kontakt neexistuje')
    if (Array.isArray(input.groups)) setContactGroups(db, id, input.groups)
    return { id, ...c, groups: groupMap(db).get(id) ?? [] }
  }
  const r = db.prepare('INSERT INTO contacts (name, email, phone, company, note, address) VALUES (?, ?, ?, ?, ?, ?)').run(c.name, c.email, c.phone, c.company, c.note, c.address)
  const newId = Number(r.lastInsertRowid)
  if (Array.isArray(input.groups)) setContactGroups(db, newId, input.groups)
  return { id: newId, ...c, groups: groupMap(db).get(newId) ?? [] }
}

/** Zmaže kontakty; prepojené so serverom (synchronizácia) sa zmažú aj tam pri ďalšej synchronizácii. */
export function deleteContacts(db: Db, ids: number[]): void {
  const get = db.prepare('SELECT sync_account, remote_href, remote_etag FROM contacts WHERE id = ?')
  const tomb = db.prepare('INSERT INTO contact_tombstones (account_id, href, etag) VALUES (?, ?, ?)')
  const del = db.prepare('DELETE FROM contacts WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const id of ids) {
      const r = get.get(id) as { sync_account: number | null; remote_href: string | null; remote_etag: string | null } | undefined
      if (r?.sync_account && r.remote_href) tomb.run(r.sync_account, r.remote_href, r.remote_etag)
      del.run(id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Uloží adresy z pošty do adresára (s menom, ktoré Doar pozná). Existujúce kontakty nemení. */
export function addFromMail(db: Db, emails: string[]): { added: number } {
  const get = db.prepare('SELECT email, name FROM addresses WHERE email = lower(?)')
  const ins = db.prepare('INSERT OR IGNORE INTO contacts (name, email) VALUES (?, ?)')
  let added = 0
  for (const e of emails.slice(0, 10_000)) {
    if (typeof e !== 'string' || !isEmail(e)) continue
    const a = get.get(e) as { email: string; name: string } | undefined
    added += Number(ins.run(clip(a?.name ?? '', MAX.name), a?.email ?? e.toLowerCase()).changes)
  }
  return { added }
}

/* ---------------- import ---------------- */

export interface ParsedContact {
  name: string
  emails: string[]
  phone: string
  company: string
  note: string
  address: string
}

/** Text súboru: UTF-8 (aj s BOM), inak Windows-1250 (staršie exporty z Outlooku v slovenčine a češtine). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '')
  } catch {
    return new TextDecoder('windows-1250').decode(buf)
  }
}

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  const cs = (charset ?? '').toLowerCase()
  if (cs && cs !== 'utf-8' && cs !== 'utf8') {
    try {
      return new TextDecoder(cs).decode(bytes)
    } catch {
      /* neznáma znaková sada */
    }
  }
  return decodeText(bytes)
}

function decodeQp(s: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else out.push(...Buffer.from(ch, 'utf8'))
  }
  return Buffer.from(out)
}

const unescapeV = (s: string): string => s.replace(/\\([nN,;:\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

/** Rozdelí hodnotu podľa ; (nie escapovanej). */
function splitSemi(s: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      cur += s[i]! + s[i + 1]!
      i++
    } else if (s[i] === ';') {
      out.push(cur)
      cur = ''
    } else cur += s[i]
  }
  out.push(cur)
  return out
}

interface VProp {
  name: string
  params: Map<string, string[]>
  value: string
}

function parseLine(line: string): VProp | null {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const [head, ...rawParams] = line.slice(0, colon).split(';')
  const name = (head ?? '').replace(/^.*\./, '').toUpperCase()
  const params = new Map<string, string[]>()
  for (const p of rawParams) {
    const eq = p.indexOf('=')
    // vCard 2.1: holé hodnoty (INTERNET, PREF, QUOTED-PRINTABLE) sú typ alebo kódovanie.
    const key = eq < 0 ? (/^(quoted-printable|base64|b|8bit|7bit)$/i.test(p) ? 'ENCODING' : 'TYPE') : p.slice(0, eq).toUpperCase()
    const vals = (eq < 0 ? p : p.slice(eq + 1)).split(',').map((v) => v.replace(/^"|"$/g, '').toLowerCase())
    params.set(key, [...(params.get(key) ?? []), ...vals])
  }
  return { name, params, value: line.slice(colon + 1) }
}

function propText(p: VProp): string {
  const enc = p.params.get('ENCODING')?.[0]
  const charset = p.params.get('CHARSET')?.[0]
  if (enc === 'quoted-printable') return decodeBytes(decodeQp(p.value), charset)
  if (enc === 'b' || enc === 'base64') return ''
  return p.value
}

/** Adresa ako text na obálku: ulica, PSČ a mesto, kraj, krajina – každé na riadku. */
function joinAddress(street: string, ext: string, city: string, zip: string, region: string, country: string): string {
  return [street, ext, [zip, city].filter(Boolean).join(' '), region, country]
    .map((x) => x.trim())
    .filter(Boolean)
    .join('\n')
}

export function parseVcards(text: string): ParsedContact[] {
  // Zložené riadky (vCard 3/4: nový riadok + medzera), vCard 2.1 quoted-printable: „=“ na konci riadku.
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  const lines: string[] = []
  for (const l of raw) {
    const prev = lines.length ? lines[lines.length - 1]! : null
    if (prev !== null && /^[ \t]/.test(l)) lines[lines.length - 1] = prev + l.slice(1)
    else if (prev !== null && /quoted-printable/i.test(prev.split(':')[0] ?? '') && prev.endsWith('=')) lines[lines.length - 1] = prev.slice(0, -1) + l
    else lines.push(l)
  }
  const out: ParsedContact[] = []
  let cur: { fn: string; n: string; emails: { v: string; pref: boolean }[]; tels: string[]; org: string; note: string; adr: string } | null = null
  for (const line of lines) {
    const p = parseLine(line.trim())
    if (!p) continue
    if (p.name === 'BEGIN' && /^vcard$/i.test(p.value.trim())) {
      cur = { fn: '', n: '', emails: [], tels: [], org: '', note: '', adr: '' }
      continue
    }
    if (!cur) continue
    if (p.name === 'END') {
      const emails = cur.emails.sort((a, b) => Number(b.pref) - Number(a.pref)).map((e) => e.v)
      let name = cur.fn
      if (!name && cur.n) {
        const [family = '', given = '', additional = '', prefix = '', suffix = ''] = splitSemi(cur.n).map(unescapeV)
        name = [prefix, given, additional, family, suffix].map((x) => x.trim()).filter(Boolean).join(' ')
      }
      out.push({ name: name.replace(/\s+/g, ' ').trim(), emails, phone: cur.tels.join(', '), company: cur.org, note: cur.note, address: cur.adr })
      cur = null
      continue
    }
    const v = propText(p)
    if (p.name === 'FN') cur.fn = unescapeV(v).trim()
    else if (p.name === 'N') cur.n = v
    else if (p.name === 'EMAIL') {
      const e = unescapeV(v).trim().replace(/^mailto:/i, '')
      const pref = (p.params.get('TYPE') ?? []).includes('pref') || p.params.has('PREF')
      if (isEmail(e) && !cur.emails.some((x) => x.v.toLowerCase() === e.toLowerCase())) cur.emails.push({ v: e, pref })
    } else if (p.name === 'TEL') {
      const t = unescapeV(v).trim().replace(/^tel:/i, '')
      if (t && !cur.tels.includes(t)) cur.tels.push(t)
    } else if (p.name === 'ORG') cur.org = splitSemi(v).map(unescapeV).map((x) => x.trim()).filter(Boolean).join(' ')
    else if (p.name === 'NOTE') cur.note = unescapeV(v).trim()
    else if (p.name === 'ADR' && !cur.adr) {
      // PO box; doplnok; ulica; mesto; kraj; PSČ; krajina
      const [, ext = '', street = '', city = '', region = '', zip = '', country = ''] = splitSemi(v).map(unescapeV).map((x) => x.trim())
      cur.adr = joinAddress(street, ext, city, zip, region, country)
    }
  }
  return out
}

/** CSV (RFC 4180): úvodzovky, viacriadkové polia; oddeľovač čiarka, bodkočiarka alebo tabulátor. */
export function parseCsvRows(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (d: string): number => {
    let n = 0
    let q = false
    for (const ch of firstLine) {
      if (ch === '"') q = !q
      else if (ch === d && !q) n++
    }
    return n
  }
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0]!
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') q = false
      else field += ch
    } else if (ch === '"' && field === '') q = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((c) => c.trim())) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((c) => c.trim())) rows.push(row)
  return rows
}

// Hlavičky stĺpcov (bez diakritiky, malými písmenami) – Outlook, Gmail, Apple, Excel v rôznych jazykoch.
const H_SKIP = /(type|typ|label|display|zobraz|druh|art\b)/
const H_FULL = /^(name|full name|display name|meno a priezvisko|cele meno|celé meno|jmeno a prijmeni|vollstandiger name|nom complet|nombre completo|teljes nev|полное имя|имя и фамилия)$/
const H_FIRST = /^(first name|given name|meno|krstne meno|jmeno|krestni jmeno|vorname|prenom|nombre|utonev|keresztnev|имя)$/
const H_MIDDLE = /^(middle name|additional name|stredne meno|druhe meno|prostredni jmeno|weitere vornamen|deuxieme prenom|segundo nombre|отчество)$/
const H_LAST = /^(last name|family name|surname|priezvisko|prijmeni|nachname|nom|apellidos?|vezeteknev|фамилия)$/
const H_COMPANY = /^(company|organization|organization name|organization 1 - name|spolocnost|firma|spolecnost|organizacia|unternehmen|societe|empresa|ceg|компания|организация)$/
const H_NOTE = /^(notes?|poznamky|poznamka|notizen|remarques|notas|megjegyzesek|заметки)$/
const H_PHONE = /(phone|telefon|tel\b|mobil|mobile|handy|telephone|telefono|telefonszam|телефон)/
const A_FORMATTED = /(formatted|formatovan|naformatovan)/
const A_PARTS = {
  street: /(street|ulica|ulice|strasse|rue|calle|utca|улица)/,
  city: /(city|mesto|obec|ort\b|stadt|ville|ciudad|varos|город)/,
  zip: /(postal code|zip|psc|plz|code postal|codigo postal|iranyitoszam|индекс)/,
  // Krajina pred krajom: „Home Country/Region“ je krajina.
  country: /(country\/region|krajina\/oblast|country|krajina|zeme|land\b|pays|pais|orszag|страна)/,
  region: /(state|region|kraj\b|bundesland|provincia|megye|область)/
} as const

export function parseCsvContacts(text: string): ParsedContact[] {
  const rows = parseCsvRows(text)
  if (rows.length < 2) return []
  const head = rows[0]!.map((h) => fold(h.trim()))
  const idx = (re: RegExp): number => head.findIndex((h) => re.test(h))
  const emailCols = head.map((h, i) => (/e-?\s?mail/.test(h) && !H_SKIP.test(h) && !/(name|meno|jmeno|nazov)/.test(h) ? i : -1)).filter((i) => i >= 0)
  const phoneCols = head.map((h, i) => (H_PHONE.test(h) && !H_SKIP.test(h) ? i : -1)).filter((i) => i >= 0)
  // Mobil najprv – najčastejšie používané číslo.
  phoneCols.sort((a, b) => Number(/mobil|mobile|handy|cell/.test(head[b]!)) - Number(/mobil|mobile|handy|cell/.test(head[a]!)))
  const full = idx(H_FULL)
  const first = idx(H_FIRST)
  const middle = idx(H_MIDDLE)
  const last = idx(H_LAST)
  const company = idx(H_COMPANY)
  const note = idx(H_NOTE)
  // Adresy: skupiny stĺpcov s rovnakou predponou (Home Street + Home City…, Address 1 - Street…, „(domov)“).
  type Parts = Partial<Record<keyof typeof A_PARTS | 'formatted', number>>
  const groups = new Map<string, Parts>()
  head.forEach((h, i) => {
    if (H_SKIP.test(h) || /e-?\s?mail|phone|telefon/.test(h)) return
    if (/address|adresa|adresse|direccion|cim\b|адрес/.test(h) && A_FORMATTED.test(h)) {
      const key = h.replace(A_FORMATTED, '').replace(/\W+/g, ' ').trim()
      groups.set(key, { ...(groups.get(key) ?? {}), formatted: i })
      return
    }
    for (const [part, re] of Object.entries(A_PARTS) as [keyof typeof A_PARTS, RegExp][]) {
      if (!re.test(h)) continue
      const key = h.replace(re, '').replace(/\W+/g, ' ').trim()
      const g = groups.get(key) ?? {}
      if (g[part] === undefined) g[part] = i
      groups.set(key, g)
      break
    }
  })
  const addressGroups = [...groups.values()].filter((g) => g.formatted !== undefined || g.street !== undefined || g.city !== undefined)
  const out: ParsedContact[] = []
  for (const r of rows.slice(1)) {
    const cell = (i: number): string => (i >= 0 ? (r[i] ?? '').trim() : '')
    let emails = emailCols.flatMap((i) => cell(i).split(/[\s,;]+/)).filter(isEmail)
    // Neznáme hlavičky: e-mail v ktoromkoľvek stĺpci.
    if (!emailCols.length) emails = r.map((c) => c.trim()).filter(isEmail)
    emails = emails.filter((e, i) => emails.findIndex((x) => x.toLowerCase() === e.toLowerCase()) === i)
    const name = cell(full) || [cell(first), cell(middle), cell(last)].filter(Boolean).join(' ')
    const phones = phoneCols.map(cell).filter(Boolean)
    let address = ''
    for (const g of addressGroups) {
      const c = (i: number | undefined): string => (i === undefined ? '' : cell(i))
      address = c(g.formatted).replace(/\r\n?/g, '\n') || joinAddress(c(g.street).replace(/\r\n?/g, '\n'), '', c(g.city), c(g.zip), c(g.region), c(g.country))
      if (address) break
    }
    out.push({ name: name.replace(/\s+/g, ' '), emails, phone: [...new Set(phones)].join(', '), company: cell(company), note: cell(note), address })
  }
  return out
}

/** Obsah súboru podľa prípony a obsahu: vCard alebo CSV. */
export function parseContactsFile(name: string, buf: Buffer): ParsedContact[] {
  const text = decodeText(buf)
  if (/\.vcf$|\.vcard$/i.test(name) || /^\s*BEGIN:VCARD/im.test(text.slice(0, 4096))) return parseVcards(text)
  return parseCsvContacts(text)
}

/**
 * Zlúči importované kontakty do adresára. Nový e-mail = nový kontakt. Existujúci kontakt sa nemení,
 * len sa doplnia prázdne polia (meno, telefón, firma, poznámka) – nič, čo používateľ napísal, sa neprepíše.
 */
export function mergeContacts(db: Db, items: ParsedContact[]): { added: number; updated: number; skipped: number } {
  let added = 0
  let updated = 0
  let skipped = 0
  const get = db.prepare(`SELECT ${COLS} FROM contacts WHERE email = ?`)
  // Bez e-mailu: rovnaký kontakt = rovnaké meno a telefón (opakovaný import nič nezdvojí).
  const getNoEmail = db.prepare(`SELECT ${COLS} FROM contacts WHERE email = '' AND name = ? AND phone = ?`)
  const ins = db.prepare('INSERT INTO contacts (name, email, phone, company, note, address) VALUES (?, ?, ?, ?, ?, ?)')
  const upd = db.prepare(
    `UPDATE contacts SET name = ?, phone = ?, company = ?, note = ?, address = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       dirty = CASE WHEN remote_href IS NOT NULL THEN 1 ELSE dirty END WHERE id = ?`
  )
  db.exec('BEGIN')
  try {
    for (const it of items.slice(0, 100_000)) {
      const base = { name: clip(it.name, MAX.name).replace(/\s+/g, ' '), phone: clip(it.phone, MAX.phone), company: clip(it.company, MAX.company), note: clip(it.note, MAX.note), address: clip(it.address, MAX.address) }
      if (!it.emails.length && !base.name && !base.phone && !base.company) {
        skipped++
        continue
      }
      for (const email of it.emails.length ? it.emails : ['']) {
        const c = base
        const ex = (email ? get.get(email) : getNoEmail.get(c.name, c.phone)) as Row | undefined
        if (!ex) {
          ins.run(c.name, email.slice(0, MAX.email), c.phone, c.company, c.note, c.address)
          added++
          continue
        }
        const next = { name: ex.name || c.name, phone: ex.phone || c.phone, company: ex.company || c.company, note: ex.note || c.note, address: ex.address || c.address }
        if (next.name !== ex.name || next.phone !== ex.phone || next.company !== ex.company || next.note !== ex.note || next.address !== ex.address) {
          upd.run(next.name, next.phone, next.company, next.note, next.address, ex.id)
          updated++
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { added, updated, skipped }
}

/* ---------------- export ---------------- */

export const escapeV = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1')

/** Riadok vCard zložený po 75 bajtoch (UTF-8 znak sa nerozdelí). */
export function foldLine(line: string): string {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const b = Buffer.byteLength(ch)
    if (bytes + b > (out.length ? 74 : 75)) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += b
  }
  out.push(cur)
  return out.join('\r\n ')
}

export function splitName(name: string): { given: string; family: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return { given: parts[0] ?? '', family: '' }
  return { given: parts.slice(0, -1).join(' '), family: parts.at(-1)! }
}

export function toVcards(list: Contact[]): string {
  return list
    .map((c) => {
      const { given, family } = splitName(c.name)
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escapeV(c.name || c.email || c.phone)}`, `N:${escapeV(family)};${escapeV(given)};;;`]
      if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${c.email}`)
      if (c.phone) lines.push(`TEL:${escapeV(c.phone)}`)
      if (c.company) lines.push(`ORG:${escapeV(c.company)}`)
      if (c.address) lines.push(`ADR;TYPE=HOME:;;${escapeV(c.address)};;;;`)
      if (c.note) lines.push(`NOTE:${escapeV(c.note)}`)
      lines.push('END:VCARD')
      return lines.map(foldLine).join('\r\n')
    })
    .join('\r\n') + '\r\n'
}

/** CSV s hlavičkami Outlooku – rozumie mu Outlook, Gmail aj Excel (UTF-8 s BOM). */
export function toCsv(list: Contact[]): string {
  const q = (s: string): string => (/[",;\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const rows = [['First Name', 'Last Name', 'E-mail Address', 'Mobile Phone', 'Company', 'Home Street', 'Notes']]
  for (const c of list) {
    const { given, family } = splitName(c.name)
    rows.push([given, family, c.email, c.phone, c.company, c.address, c.note])
  }
  return '\uFEFF' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n'
}

/* ---------- skupiny (napr. „Rodina“) – len v Doare ---------- */

/** Skupiny kontaktov podľa kontaktu (pre zoznam). */
function groupMap(db: Db): Map<number, number[]> {
  const m = new Map<number, number[]>()
  for (const r of db.prepare('SELECT contact_id, group_id FROM contact_group_members').all() as { contact_id: number; group_id: number }[]) {
    const list = m.get(r.contact_id) ?? []
    list.push(r.group_id)
    m.set(r.contact_id, list)
  }
  return m
}

/** Kontakty s ich skupinami; groupId = len kontakty tej skupiny. */
export function listContactsWithGroups(db: Db, query = '', groupId?: number): Contact[] {
  const groups = groupMap(db)
  return listContacts(db, query)
    .map((c) => ({ ...c, groups: groups.get(c.id) ?? [] }))
    .filter((c) => groupId === undefined || c.groups.includes(groupId))
}

export function listGroups(db: Db): ContactGroup[] {
  return db
    .prepare(
      `SELECT g.id, g.name, COUNT(m.contact_id) AS count, COUNT(CASE WHEN c.email != '' THEN 1 END) AS withEmail
       FROM contact_groups g LEFT JOIN contact_group_members m ON m.group_id = g.id LEFT JOIN contacts c ON c.id = m.contact_id
       GROUP BY g.id ORDER BY g.name COLLATE NOCASE`
    )
    .all() as unknown as ContactGroup[]
}

export function saveGroup(db: Db, input: { id?: number; name: string }): ContactGroup {
  const name = clip(input?.name, 100).replace(/\s+/g, ' ')
  if (!name) throw err('GROUP_NAME', 'Zadajte názov skupiny')
  // Bez ohľadu na veľké písmená (aj s diakritikou – NOCASE v SQLite pozná len ASCII).
  const clash = (db.prepare('SELECT id, name FROM contact_groups').all() as { id: number; name: string }[]).find((g) => g.name.toLocaleLowerCase('sk') === name.toLocaleLowerCase('sk'))
  if (clash && clash.id !== input.id) throw err('GROUP_EXISTS', 'Skupina s týmto názvom už existuje')
  let id: number
  if (Number.isInteger(input.id)) {
    if (!db.prepare('UPDATE contact_groups SET name = ? WHERE id = ?').run(name, input.id as number).changes) throw err('NOT_FOUND', 'Skupina neexistuje')
    id = input.id as number
  } else id = (db.prepare('INSERT INTO contact_groups (name) VALUES (?) RETURNING id').get(name) as { id: number }).id
  return listGroups(db).find((g) => g.id === id)!
}

export function deleteGroup(db: Db, id: number): void {
  // Kontakty ostanú, zmizne len skupina.
  db.prepare('DELETE FROM contact_groups WHERE id = ?').run(id)
}

export function setGroupMembers(db: Db, groupId: number, change: { add?: number[]; remove?: number[] }): void {
  if (!db.prepare('SELECT 1 FROM contact_groups WHERE id = ?').get(groupId)) throw err('NOT_FOUND', 'Skupina neexistuje')
  const add = db.prepare('INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) SELECT ?, id FROM contacts WHERE id = ?')
  const del = db.prepare('DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?')
  db.exec('BEGIN')
  try {
    for (const id of change.add ?? []) add.run(groupId, id)
    for (const id of change.remove ?? []) del.run(groupId, id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Skupiny kontaktu: nastaví presne tieto (pri uložení kontaktu). */
export function setContactGroups(db: Db, contactId: number, groups: number[]): void {
  db.prepare('DELETE FROM contact_group_members WHERE contact_id = ?').run(contactId)
  const add = db.prepare('INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) SELECT id, ? FROM contact_groups WHERE id = ?')
  for (const g of groups) if (Number.isInteger(g)) add.run(contactId, g)
}

/** Adresy kontaktov skupiny (len s e-mailom), zoradené podľa mena. */
export function groupAddresses(db: Db, groupId: number): Address[] {
  return (db
    .prepare(
      `SELECT c.name, c.email AS address FROM contact_group_members m JOIN contacts c ON c.id = m.contact_id
       WHERE m.group_id = ? AND c.email != '' ORDER BY c.name COLLATE NOCASE, c.email`
    )
    .all(groupId) as unknown as Address[])
}

/** Skupiny, ktorých názov sa začína hľadaným textom (bez diakritiky) – pre našepkávanie adresátov. */
export function suggestGroups(db: Db, query: string): { id: number; name: string; members: Address[] }[] {
  const q = fold(query.trim())
  if (!q) return []
  return listGroups(db)
    .filter((g) => g.withEmail > 0 && fold(g.name).split(/\s+/).some((w) => w.startsWith(q)))
    .slice(0, 3)
    .map((g) => ({ id: g.id, name: g.name, members: groupAddresses(db, g.id) }))
}
