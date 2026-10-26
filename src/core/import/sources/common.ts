import type { SpecialUseFlag } from '../../export/mboxrd'

/**
 * Spoločné pre import z iných programov (Windows Mail, Outlook Express, Outlook):
 * každý zdroj vráti správy ako pôvodný text RFC 5322 + priečinok + príznaky.
 * Z nich sa zloží dočasný súbor vo formáte zálohy Doar a ďalej ide bežná obnova.
 */

export type SourceFormat = 'eml' | 'dbx' | 'pst'

export interface SourceMessage {
  /** Pôvodná správa (hlavičky a telo), ľubovoľné konce riadkov. */
  raw: Buffer
  /** Cesta priečinka v zdroji (od koreňa). Prázdna = zvolený priečinok. */
  folder: string[]
  flags: Set<string>
  /** Dátum prijatia (ak ho zdroj pozná). */
  internalDate: Date | null
}

export interface SourceInfo {
  format: SourceFormat
  /** Odhad počtu správ (na priebeh a náhľad). */
  messages: number
  folders: number
}

export interface SourceProgress {
  done: number
  total: number
}

/** Správa sa nedala prečítať (poškodená) – preskočí sa a započíta do súhrnu. */
export class SourceSkip extends Error {}

/** Názvy štandardných priečinkov v jazykoch, v ktorých sa programy predávali (porovnáva sa bez diakritiky a veľkosti písmen). */
const SPECIAL_NAMES: Record<Exclude<SpecialUseFlag, '\\All' | '\\Archive'>, string[]> = {
  '\\Inbox': ['inbox', 'dorucena posta', 'prijata posta', 'posteingang', 'beerkezett uzenetek', 'boite de reception', 'bandeja de entrada', 'входящие', 'דואר נכנס'],
  '\\Sent': [
    'sent items',
    'sent',
    'sent mail',
    'odoslana posta',
    'odoslane',
    'odeslana posta',
    'odeslane',
    'gesendete elemente',
    'gesendete objekte',
    'elkuldott elemek',
    'elements envoyes',
    'elementos enviados',
    'отправленные',
    'פריטים שנשלחו'
  ],
  '\\Drafts': ['drafts', 'koncepty', 'entwurfe', 'piszkozatok', 'brouillons', 'borradores', 'черновики', 'טיוטות'],
  '\\Trash': [
    'deleted items',
    'trash',
    'odstranena posta',
    'odstranene polozky',
    'odstranene',
    'kos',
    'gelöschte elemente',
    'geloschte elemente',
    'torolt elemek',
    'elements supprimes',
    'elementos eliminados',
    'удаленные',
    'פריטים שנמחקו'
  ],
  '\\Junk': [
    'junk e-mail',
    'junk email',
    'junk',
    'spam',
    'nevyziadana posta',
    'nevyzadana posta',
    'junk-e-mail',
    'levelszemet',
    'courrier indesirable',
    'correo no deseado',
    'нежелательная почта',
    'דואר זבל'
  ]
}

export function plainName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Štandardný priečinok podľa názvu – len na najvyššej úrovni (podpriečinok „Odoslané“ v projekte nie je Odoslaná pošta). */
export function specialUseFor(folder: string[]): SpecialUseFlag | null {
  if (folder.length !== 1) return null
  const n = plainName(folder[0]!)
  for (const [flag, names] of Object.entries(SPECIAL_NAMES)) if (names.includes(n)) return flag as SpecialUseFlag
  return null
}

// Bajty, ktoré sa v stredoeurópskom kódovaní (windows-1250) čítajú inak než v západnom (windows-1252):
// č Č ř Ř ě Ě ň Ň ľ ů ď ť Ť ĺ ő ű …
const CE_BYTES = new Set([0xe8, 0xc8, 0xf8, 0xd8, 0xec, 0xcc, 0xf2, 0xd2, 0xbe, 0xbc, 0xf9, 0xd9, 0xef, 0xcf, 0x9d, 0x8d, 0xe5, 0xc5, 0xf5, 0xd5, 0xfb, 0xdb])

/**
 * Text v kódovaní Windows (ANSI) – názvy priečinkov Outlook Express. Platné UTF-8 sa berie ako UTF-8,
 * inak stredoeurópske kódovanie, ak obsahuje typické znaky (čeština, slovenčina, maďarčina), inak západné.
 */
export function decodeAnsi(buf: Buffer): string {
  if (!buf.some((b) => b >= 0x80)) return buf.toString('latin1')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    const ce = buf.some((b) => CE_BYTES.has(b))
    return new TextDecoder(ce ? 'windows-1250' : 'windows-1252').decode(buf)
  }
}

/** Dátum z hlavičky Date (alebo null). */
export function headerDate(raw: Buffer): Date | null {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('latin1')
  const end = head.search(/\r?\n\r?\n/)
  const block = (end >= 0 ? head.slice(0, end) : head).replace(/\r?\n[ \t]+/g, ' ')
  const m = block.match(/^date:[ \t]*(.+)$/im)
  if (!m) return null
  const d = Date.parse(m[1]!.trim())
  return Number.isNaN(d) ? null : new Date(d)
}

/** Vyzerá obsah ako e-mail (aspoň jedna známa hlavička v prvých riadkoch)? */
export function looksLikeMessage(raw: Buffer): boolean {
  const head = raw.subarray(0, 8192).toString('latin1')
  return /^(from|to|subject|date|received|return-path|message-id|mime-version|x-[a-z-]+):/im.test(head)
}

/** Nechá jadro vybaviť ostatné požiadavky (dlhý import nesmie zablokovať aplikáciu). */
export const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r))
