/**
 * Vyhľadávanie: text od používateľa → dotaz FTS5.
 *
 * - Slová sa hľadajú ako začiatky slov („faktur“ nájde „faktúra“), bez ohľadu na diakritiku a veľké písmená
 *   (tokenizer `unicode61 remove_diacritics 2`).
 * - Všetky slová musia byť v správe (AND), v ľubovoľnom poli.
 * - „v úvodzovkách“ = presná fráza.
 * - Predpony polí: od: / from:, komu: / to:, predmet: / subject: (napr. `od:jan predmet:"cenová ponuka"`).
 * - Používateľ nemôže písať syntax FTS5 (NOT, NEAR, stĺpce…) – všetko sa berie ako text.
 */

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

/** Rozdelí vstup na výrazy (s poľom a frázou). */
export function parseSearch(input: string): SearchTerm[] {
  const out: SearchTerm[] = []
  const re = /(?:([\p{L}]+):)?(?:"([^"]*)"?|(\S+))/gu
  for (const m of (input ?? '').slice(0, 500).matchAll(re)) {
    const prefix = m[1]?.toLowerCase()
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

/** Dotaz FTS5, alebo null, ak nie je čo hľadať. */
export function buildFtsQuery(input: string): string | null {
  const terms = parseSearch(input)
  if (!terms.length) return null
  return terms
    .map((t) => {
      // Fráza presne; slovo (aj „jan@firma.sk“ – rozpadne sa na tokeny) ako začiatok posledného tokenu.
      const q = t.phrase ? quote(t.text) : `${quote(t.text)}*`
      return t.field ? `${t.field} : ${q}` : q
    })
    .join(' AND ')
}
