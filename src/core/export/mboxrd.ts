import { createHash } from 'node:crypto'

/**
 * Formát zálohy Doar: mboxrd + blok metadát X-Doar- (docs/MBOX-METADATA.md, verzia 1).
 * Všetko sa spracúva ako latin1 reťazec = 1 bajt na 1 znak, takže 8-bitový obsah prejde bez zmeny.
 */

export const FORMAT_VERSION = 1

export type SpecialUseFlag = '\\Inbox' | '\\Sent' | '\\Drafts' | '\\Trash' | '\\Junk' | '\\Archive' | '\\All'

export interface MessageMeta {
  source: string
  /** Cesta priečinka v Unicode, segmenty v poradí od koreňa. */
  folderSegments: string[]
  specialUse: SpecialUseFlag | null
  internalDate: Date | null
  flags: Set<string>
  gmailLabels?: string[]
}

/** Kanonický tvar: všetky konce riadkov CRLF a správa končí CRLF. Z neho sa počíta hash. */
export function canonicalize(raw: Buffer): Buffer {
  let s = raw.toString('latin1').replace(/\r\n|\r|\n/g, '\r\n')
  if (!s.endsWith('\r\n')) s += '\r\n'
  return Buffer.from(s, 'latin1')
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

const KEEP = /[A-Za-z0-9\-_.~[\]$\\]/

/** Percent-encoding jedného segmentu (UTF-8). Zachované sú len znaky A–Z a–z 0–9 - _ . ~ [ ] $ \ */
export function encodeSegment(segment: string): string {
  let out = ''
  for (const ch of segment) {
    if (KEEP.test(ch)) out += ch
    else for (const b of Buffer.from(ch, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

export function decodeSegment(encoded: string): string {
  return decodeURIComponent(encoded)
}

export function encodeFolderPath(segments: string[]): string {
  return segments.map(encodeSegment).join('/')
}

export function decodeFolderPath(encoded: string): string[] {
  return encoded === '' ? [] : encoded.split('/').map(decodeSegment)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Dátum vo formáte asctime v UTC: „Wed Oct  1 14:36:00 2026“. */
export function asctime(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

/** Odosielateľ pre riadok „From “ – z hlavičky Return-Path, ak je to platná adresa bez medzier. */
export function envelopeSender(canonical: Buffer): string {
  const head = canonical.toString('latin1').split('\r\n\r\n', 1)[0] ?? ''
  const m = head.match(/^return-path:[ \t]*<?([^<>\s]*)>?/im)
  const addr = m?.[1] ?? ''
  return /^[^\s<>@"]+@[^\s<>@"]+$/.test(addr) ? addr : 'MAILER-DAEMON'
}

export function separatorLine(canonical: Buffer, internalDate: Date | null): string {
  return `From ${envelopeSender(canonical)} ${asctime(internalDate ?? new Date(0))}`
}

const SYSTEM_FLAGS = ['\\Seen', '\\Flagged', '\\Answered', '\\Draft'] as const

/** Blok metadát Doar (riadky bez koncov riadkov). Prvý riadok vždy X-Doar-Version s počtom riadkov. */
export function metadataBlock(meta: MessageMeta, hash: string): string[] {
  const flags = SYSTEM_FLAGS.filter((f) => meta.flags.has(f))
  const keywords = [...meta.flags].filter((f) => !f.startsWith('\\')).sort()
  const lines: string[] = [
    `X-Doar-Source: ${meta.source}`,
    `X-Doar-Folder: ${encodeFolderPath(meta.folderSegments)}`,
    `X-Doar-Special-Use: ${meta.specialUse ?? ''}`.trimEnd(),
    `X-Doar-Internal-Date: ${meta.internalDate ? meta.internalDate.toISOString().replace(/\.\d{3}Z$/, 'Z') : ''}`.trimEnd(),
    `X-Doar-Flags: ${flags.join(' ')}`.trimEnd()
  ]
  if (keywords.length) lines.push(`X-Doar-Keywords: ${keywords.map(encodeSegment).join(' ')}`)
  if (meta.gmailLabels?.length) lines.push(`X-Doar-Gmail-Labels: ${meta.gmailLabels.map(encodeSegment).join(' ')}`)
  lines.push(`X-Doar-Hash: sha256=${hash}`)
  lines.push(`Status: ${meta.flags.has('\\Seen') ? 'RO' : 'O'}`)
  const x = `${meta.flags.has('\\Answered') ? 'A' : ''}${meta.flags.has('\\Flagged') ? 'F' : ''}${meta.flags.has('\\Draft') ? 'T' : ''}`
  if (x) lines.push(`X-Status: ${x}`)
  const total = lines.length + 1
  return [`X-Doar-Version: ${FORMAT_VERSION}; lines=${total}`, ...lines]
}

/**
 * Jedna správa v tvare mboxrd: oddeľovač, blok metadát, pôvodná správa (konce riadkov LF,
 * riadky „>*From “ s jedným „>“ navyše) a prázdny riadok na konci.
 */
export function encodeMessage(raw: Buffer, meta: MessageMeta): { chunk: Buffer; hash: string } {
  const canonical = canonicalize(raw)
  const hash = sha256(canonical)
  const lines = canonical.toString('latin1').split('\r\n')
  lines.pop() // posledný CRLF ukončuje posledný riadok
  const body = lines.map((l) => (/^>*From /.test(l) ? `>${l}` : l))
  const out = [separatorLine(canonical, meta.internalDate), ...metadataBlock(meta, hash), ...body, ''].join('\n') + '\n'
  return { chunk: Buffer.from(out, 'latin1'), hash }
}

// ---------- čítanie (pre overenie a budúci import) ----------

export interface ParsedEntry {
  /** Správa po odstránení mboxrd escapovania, v kanonickom tvare (CRLF), vrátane bloku Doar. */
  message: Buffer
}

/**
 * Rozdelí obsah mboxrd na správy. Správa začína riadkom „From “ na začiatku súboru alebo za prázdnym riadkom.
 * Určené pre testy a menšie súbory; import (0.3) bude čítať prúdom.
 */
export function splitMboxrd(data: Buffer): ParsedEntry[] {
  const text = data.toString('latin1').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const out: ParsedEntry[] = []
  let cur: string[] | null = null
  const flush = (): void => {
    if (!cur) return
    while (cur.length && cur[cur.length - 1] === '') cur.pop() // oddeľovací prázdny riadok
    const msg = cur.map((l) => (/^>+From /.test(l) ? l.slice(1) : l)).join('\r\n') + '\r\n'
    out.push({ message: Buffer.from(msg, 'latin1') })
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith('From ') && (i === 0 || lines[i - 1] === '')) {
      flush()
      cur = []
      continue
    }
    cur?.push(l)
  }
  flush()
  return out
}

export interface DoarBlock {
  version: number
  headers: Map<string, string>
  folderSegments: string[]
  specialUse: string | null
  internalDate: Date | null
  flags: Set<string>
  gmailLabels: string[]
  hash: string | null
}

const BLOCK_HEADER = /^(X-Doar-[A-Za-z-]+|Status|X-Status):/i

/**
 * Odstráni blok metadát Doar zo začiatku správy (presne `lines` riadkov) a overí hash originálu.
 * Pri cudzej správe (bez bloku) vráti block = null a správu bez zmeny.
 */
export function stripDoarBlock(message: Buffer): { block: DoarBlock | null; original: Buffer; hashOk: boolean | null } {
  const s = message.toString('latin1')
  const first = s.slice(0, s.indexOf('\r\n'))
  const m = first.match(/^X-Doar-Version:\s*(\d+);\s*lines=(\d+)\s*$/i)
  if (!m) return { block: null, original: message, hashOk: null }
  const count = Number(m[2])
  const lines = s.split('\r\n')
  if (count < 1 || count > lines.length) return { block: null, original: message, hashOk: null }
  const blockLines = lines.slice(0, count)
  if (!blockLines.every((l) => BLOCK_HEADER.test(l))) return { block: null, original: message, hashOk: null }
  const headers = new Map<string, string>()
  for (const l of blockLines) {
    const i = l.indexOf(':')
    headers.set(l.slice(0, i).toLowerCase(), l.slice(i + 1).trim())
  }
  const original = Buffer.from(lines.slice(count).join('\r\n'), 'latin1')
  const hashHeader = headers.get('x-doar-hash')?.match(/^sha256=([0-9a-f]{64})$/)?.[1] ?? null
  const flags = new Set((headers.get('x-doar-flags') ?? '').split(/\s+/).filter(Boolean))
  for (const k of (headers.get('x-doar-keywords') ?? '').split(/\s+/).filter(Boolean)) flags.add(decodeSegment(k))
  const dateStr = headers.get('x-doar-internal-date') ?? ''
  const date = dateStr ? new Date(dateStr) : null
  return {
    block: {
      version: Number(m[1]),
      headers,
      folderSegments: decodeFolderPath(headers.get('x-doar-folder') ?? ''),
      specialUse: headers.get('x-doar-special-use') || null,
      internalDate: date && !Number.isNaN(date.getTime()) ? date : null,
      flags,
      gmailLabels: (headers.get('x-doar-gmail-labels') ?? '').split(/\s+/).filter(Boolean).map(decodeSegment),
      hash: hashHeader
    },
    original,
    hashOk: hashHeader ? sha256(original) === hashHeader : null
  }
}
