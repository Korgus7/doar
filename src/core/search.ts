/**
 * Vyhľadávanie: text od používateľa → dotaz FTS5.
 *
 * - Slová sa hľadajú ako začiatky slov („faktur“ nájde „faktúra“), bez ohľadu na diakritiku a veľké písmená
 *   (tokenizer `unicode61 remove_diacritics 2`).
 * - Všetky slová musia byť v správe (AND), v ľubovoľnom poli.
 * - „v úvodzovkách“ = presná fráza.
 * - Predpony polí: od: / from:, komu: / to:, predmet: / subject: (napr. `od:jan predmet:"cenová ponuka"`).
 * - Používateľ nemôže písať syntax FTS5 (NOT, NEAR, stĺpce…) – všetko sa berie ako text.
 * - Filtre (0.9): `má:prílohu` / `has:attachment`, `je:neprečítané` / `is:unread`, `je:označené` / `is:flagged`,
 *   `po:2026-01-31` / `after:`, `pred:` / `before:` (aj 31.1.2026). Rovnaké filtre ponúka formulár „Rozšírené hľadanie“.
 */

import type { SearchFilters } from '../shared/ipc'

/** Filtre, ktoré nie sú text (dátum, príloha, neprečítané, hviezdička). */
export interface SearchFlags {
  after: string | null
  before: string | null
  attachment: boolean
  unread: boolean
  flagged: boolean
}

const FIELDS: Record<string, string> = {
  od: 'from_text',
  from: 'from_text',
  komu: 'to_text',
  to: 'to_text',
  predmet: 'subject',
  subject: 'subject'
}

export interface SearchTerm {
  field: string | null
  text: string
  phrase: boolean
}

const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

/** Dátum „2026-01-31“ alebo „31.1.2026“ → „2026-01-31“; inak null. */
export function parseDate(v: string): string | null {
  const s = (v ?? '').trim()
  let y: number, mo: number, d: number
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else if ((m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else return null
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/** Slovo-filter (bez textu): vráti, čo nastaví, alebo null. */
function flagWord(prefix: string, value: string, flags: SearchFlags): boolean {
  const p = fold(prefix)
  const v = fold(value)
  if ((p === 'ma' || p === 'has') && /^(prilohu|prilohy|priloha|attachments?)$/.test(v)) return (flags.attachment = true)
  if (p === 'je' || p === 'is') {
    if (/^(neprecitane|neprecitana|unread)$/.test(v)) return (flags.unread = true)
    if (/^(oznacene|oznacena|s-hviezdickou|hviezdicka|flagged|starred)$/.test(v)) return (flags.flagged = true)
  }
  if (p === 'po' || p === 'after' || p === 'pred' || p === 'before') {
    const d = parseDate(value)
    if (!d) return false
    if (p === 'po' || p === 'after') flags.after = d
    else flags.before = d
    return true
  }
  return false
}

/** Rozdelí vstup na výrazy (s poľom a frázou). Filtre (príloha, dátum…) zapíše do `flags`. */
export function parseSearch(input: string, flags: SearchFlags = emptyFlags()): SearchTerm[] {
  const out: SearchTerm[] = []
  const re = /(?:([\p{L}]+):)?(?:"([^"]*)"?|(\S+))/gu
  for (const m of (input ?? '').slice(0, 500).matchAll(re)) {
    const prefix = m[1]?.toLowerCase()
    if (prefix && m[3] !== undefined && flagWord(prefix, m[3], flags)) continue
    const field = prefix && FIELDS[prefix] ? FIELDS[prefix]! : null
    let text = m[2] ?? m[3] ?? ''
    // Neznáma predpona („https:“, „8:30“) je obyčajný text.
    if (prefix && !field) text = `${m[1]}:${text}`
    if (!/[\p{L}\p{N}]/u.test(text)) continue
    out.push({ field, text, phrase: m[2] !== undefined })
  }
  return out.slice(0, 20)
}

/** Text výrazu ako reťazec FTS5 v úvodzovkách (úvodzovky vo vnútri zdvojené). */
function quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

export function emptyFlags(): SearchFlags {
  return { after: null, before: null, attachment: false, unread: false, flagged: false }
}

/** Dotaz FTS5, alebo null, ak nie je čo hľadať. */
export function buildFtsQuery(input: string): string | null {
  return ftsOf(parseSearch(input))
}

function ftsOf(terms: SearchTerm[]): string | null {
  if (!terms.length) return null
  return terms
    .map((t) => {
      // Fráza presne; slovo (aj „jan@firma.sk“ – rozpadne sa na tokeny) ako začiatok posledného tokenu.
      const q = t.phrase ? quote(t.text) : `${quote(t.text)}*`
      return t.field ? `${t.field} : ${q}` : q
    })
    .join(' AND ')
}

/** Úplné hľadanie: text z poľa + formulár „Rozšírené hľadanie“. null = nie je čo hľadať. */
export function buildSearch(input: string, f: SearchFilters = {}): { fts: string | null; flags: SearchFlags } | null {
  const flags = emptyFlags()
  const terms = parseSearch(input, flags)
  const field = (v: unknown, col: string): void => {
    if (typeof v !== 'string' || !v.trim()) return
    for (const t of parseSearch(v.slice(0, 200))) terms.push({ ...t, field: col })
  }
  field(f.from, 'from_text')
  field(f.to, 'to_text')
  field(f.subject, 'subject')
  if (typeof f.after === 'string') flags.after = parseDate(f.after) ?? flags.after
  if (typeof f.before === 'string') flags.before = parseDate(f.before) ?? flags.before
  if (f.attachment === true) flags.attachment = true
  if (f.unread === true) flags.unread = true
  if (f.flagged === true) flags.flagged = true
  const fts = ftsOf(terms.slice(0, 30))
  const any = fts || flags.after || flags.before || flags.attachment || flags.unread || flags.flagged
  return any ? { fts, flags } : null
}

/** Podmienka SQL pre filtre (stĺpce m.seen, m.flagged, m.has_attachments; dátum podľa `dateCol`). */
export function flagsWhere(flags: SearchFlags, dateCol: string): { where: string; args: string[] } {
  const parts: string[] = []
  const args: string[] = []
  if (flags.after) {
    parts.push(`${dateCol} >= ?`)
    args.push(`${flags.after}T00:00:00`)
  }
  if (flags.before) {
    // „pred 31.1.“ = vrátane 31.1. (ako vo formulári „do“).
    const next = new Date(Date.parse(`${flags.before}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    parts.push(`${dateCol} < ?`)
    args.push(`${next}T00:00:00`)
  }
  if (flags.attachment) parts.push('m.has_attachments = 1')
  if (flags.unread) parts.push('m.seen = 0')
  if (flags.flagged) parts.push('m.flagged = 1')
  return { where: parts.length ? parts.join(' AND ') : '1', args }
}

export type SearchQuery = { fts: string | null; flags: SearchFlags }

/** Starší tvar (len dotaz FTS5) aj úplné hľadanie. */
export function asQuery(q: string | SearchQuery): SearchQuery {
  return typeof q === 'string' ? { fts: q, flags: emptyFlags() } : q
}
