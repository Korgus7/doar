/**
 * Konverzácie (vlákna): pomocné funkcie bez databázy.
 * Správy sa spájajú podľa hlavičiek In-Reply-To / References (ako Thunderbird); predmet je len náhradné
 * párovanie, keď je správa zjavne odpoveď, ale pôvodnú správa Doar nemá.
 */

/** Predpony odpovedí a preposlaní v rôznych jazykoch (Re, Fwd, AW, WG, Odp, SV, VS, TR, RIF, Antw…). */
const WORDS = '(?:re|fw|fwd|aw|wg|odp|sv|vs|tr|rif|antw|réf|rv|ynt|res|r|enc|πρθ|השב|הועבר|ответ|пересл)'
const REPLY = new RegExp(`^\\s*${WORDS}\\s*(?:\\[\\d+\\])?\\s*[:：]`, 'iu')
/** Predpona odpovede, alebo značka konferencie „[zoznam]“. */
const PREFIX = new RegExp(`^\\s*(?:${WORDS}\\s*(?:\\[\\d+\\])?\\s*[:：]\\s*|\\[[^\\]]{1,40}\\]\\s*)`, 'iu')

/** Je predmet odpoveďou alebo preposlaním (aj za značkou konferencie)? */
export function isReplySubject(subject: string): boolean {
  return REPLY.test((subject ?? '').replace(/^\s*(?:\[[^\]]{1,40}\]\s*)+/, ''))
}

/** Predmet na porovnávanie: bez predpôn, malými písmenami, bez diakritiky a nadbytočných medzier. */
export function threadSubject(subject: string): string {
  let s = (subject ?? '').normalize('NFKC')
  for (let i = 0; i < 10; i++) {
    const next = s.replace(PREFIX, '')
    if (next === s) break
    s = next
  }
  return s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 300)
}

/** Message-ID v tvare <…> (prvé z hlavičky); prázdne → null. */
export function firstMessageId(v: string | null | undefined): string | null {
  if (!v) return null
  const m = /<[^<>\s]+>/.exec(v)
  return m ? m[0] : v.trim() ? `<${v.trim().replace(/^<|>$/g, '')}>` : null
}

/** Všetky Message-ID z hlavičky References (poradie od najstaršieho). */
export function messageIds(v: string | null | undefined): string[] {
  return v ? [...v.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]) : []
}
