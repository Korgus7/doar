import { open } from 'node:fs/promises'
import { canonicalize, sha256, stripDoarBlock } from '../export/mboxrd'

/**
 * Čítanie súboru mbox pre obnovu (import do konta) a lokálny archív.
 * Súbor sa číta prúdom po častiach – v pamäti je naraz len jedna správa.
 */

export class NotMboxError extends Error {
  readonly code = 'NOT_MBOX'
  constructor() {
    super('Súbor nie je vo formáte mbox')
  }
}

export interface MboxEntry {
  /** Začiatok riadku „From “ v súbore (bajty). */
  offset: number
  /** Dĺžka záznamu po ďalší riadok „From “ (bajty). */
  length: number
  raw: Buffer
}

const CHUNK = 1024 * 1024
const FROM = Buffer.from('From ', 'latin1')

/**
 * Riadok „From “ za prázdnym riadkom je oddeľovač, len ak vyzerá ako oddeľovač (čas a rok).
 * Chráni to pred rozdelením správy v cudzích súboroch (mboxo), kde „From “ v texte nie je escapované.
 */
export function looksLikeSeparator(line: string): boolean {
  return /^From \S*\s/.test(line) && /\d{1,2}:\d{2}/.test(line) && /(^|\D)\d{4}(\D|$)/.test(line)
}

function isEmptyLine(line: Buffer): boolean {
  return line.length === 0 || (line.length === 1 && line[0] === 0x0a) || (line.length === 2 && line[0] === 0x0d && line[1] === 0x0a)
}

/**
 * Prejde súbor a vráti záznamy (správy) v poradí. Prvý neprázdny riadok súboru musí začínať „From “,
 * inak nejde o mbox (NotMboxError).
 */
export async function* readMbox(path: string, opts: { signal?: AbortSignal; onBytes?: (pos: number) => void; start?: number } = {}): AsyncGenerator<MboxEntry> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let readPos = opts.start ?? 0
    let pos = readPos // začiatok práve spracúvaného riadku
    let carry = Buffer.alloc(0)
    let entryStart = -1
    let parts: Buffer[] = []
    let partsLen = 0
    let prevEmpty = true
    let first = true
    const done: MboxEntry[] = []

    const handle = (line: Buffer): void => {
      let sep = false
      if (line.length >= 5 && line[0] === 0x46 && line.subarray(0, 5).equals(FROM)) {
        if (first) sep = true
        else if (prevEmpty) sep = looksLikeSeparator(line.subarray(0, 400).toString('latin1').replace(/\r?\n$/, ''))
      }
      if (sep) {
        if (entryStart >= 0) done.push({ offset: entryStart, length: pos - entryStart, raw: Buffer.concat(parts, partsLen) })
        entryStart = pos
        parts = [line]
        partsLen = line.length
        first = false
      } else if (entryStart >= 0) {
        parts.push(line)
        partsLen += line.length
      } else if (!isEmptyLine(line)) {
        throw new NotMboxError()
      }
      prevEmpty = isEmptyLine(line)
      pos += line.length
    }

    for (;;) {
      if (opts.signal?.aborted) return
      const { bytesRead } = await fh.read(buf, 0, CHUNK, readPos)
      readPos += bytesRead
      const eof = bytesRead === 0
      const data = eof ? carry : Buffer.concat([carry, buf.subarray(0, bytesRead)])
      let start = 0
      for (;;) {
        const nl = data.indexOf(0x0a, start)
        if (nl < 0) break
        handle(data.subarray(start, nl + 1))
        start = nl + 1
      }
      carry = Buffer.from(data.subarray(start))
      if (eof) {
        if (carry.length) handle(carry)
        if (entryStart >= 0) done.push({ offset: entryStart, length: pos - entryStart, raw: Buffer.concat(parts, partsLen) })
        else if (first) throw new NotMboxError()
      }
      opts.onBytes?.(pos)
      while (done.length) yield done.shift()!
      if (eof) return
    }
  } finally {
    await fh.close()
  }
}

/** Prečíta jeden záznam zo známej pozície (pri nahrávaní a pokračovaní). */
export async function readEntryAt(path: string, offset: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const out = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await fh.read(out, got, length - got, offset + got)
      if (!bytesRead) break
      got += bytesRead
    }
    return got === length ? out : out.subarray(0, got)
  } finally {
    await fh.close()
  }
}

// ---------- jedna správa ----------

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

/** Dátum z oddeľovača „From adresa Wed Oct  1 14:36:00 2026“ (asctime, UTC). Rok 1970 = neznámy. */
export function separatorDate(line: string): Date | null {
  const m = line.match(/\b([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(?:[A-Z]{3,4}\s+|[+-]\d{4}\s+)?(\d{4})\b/)
  if (!m) return null
  const mon = MONTHS[m[1]!.toLowerCase()]
  if (mon === undefined) return null
  const year = Number(m[6])
  if (year <= 1970) return null
  const d = new Date(Date.UTC(year, mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5] ?? 0)))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Hlavičky správy (rozbalené pokračovacie riadky), názvy malými písmenami; pri opakovaní platí prvá. */
export function headerMap(message: Buffer): Map<string, string> {
  const s = message.toString('latin1')
  const end = s.indexOf('\r\n\r\n')
  const head = (end >= 0 ? s.slice(0, end) : s).replace(/\r\n[ \t]+/g, ' ')
  const map = new Map<string, string>()
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    if (!map.has(name)) map.set(name, line.slice(i + 1).trim())
  }
  return map
}

export function normMessageId(v: string | null | undefined): string {
  if (!v) return ''
  const m = v.match(/<([^<>]+)>/)
  return (m ? m[1]! : v).replace(/\s+/g, '').toLowerCase()
}

export function fromAddress(v: string | null | undefined): string {
  if (!v) return ''
  const m = v.match(/<([^<>\s]+@[^<>\s]+)>/) ?? v.match(/([^\s<>"',;:()]+@[^\s<>"',;:()]+)/)
  return (m?.[1] ?? '').toLowerCase()
}

/**
 * Kľúč na výber kandidátov na serveri: Message-ID; bez Message-ID dátum z hlavičky + odosielateľ.
 * Rovnaký kľúč sa počíta aj zo správ na serveri (obálka). Zhoda kľúča sa vždy overí celým obsahom –
 * veľkosť sa nepoužíva (server môže uložiť originál inak, napr. bez koncového CRLF alebo s holými LF).
 */
export function weakKey(messageId: string, date: number | null, from: string): string {
  return messageId ? `m:${messageId}` : `d:${date ?? ''}|${from}`
}

export interface ParsedMessage {
  /** Pôvodná správa v kanonickom tvare (CRLF) – takto sa nahrá na server. */
  original: Buffer
  /** Správa má blok metadát Doar. */
  doar: boolean
  /** Hash bloku sedí (true), nesedí – súbor upravil iný program (false), cudzia správa (null). */
  hashOk: boolean | null
  source: string | null
  folderSegments: string[] | null
  specialUse: string | null
  gmailLabels: string[]
  flags: Set<string>
  internalDate: Date | null
  fingerprint: string
  size: number
  weakKey: string
}

/** Rozloží jeden záznam mbox (vrátane riadku „From “) na správu a metadáta. */
export function parseEntry(raw: Buffer): ParsedMessage | null {
  const lines = raw.toString('latin1').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const sepLine = (lines.shift() ?? '').replace(/\r$/, '')
  const body = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (body.length && body[body.length - 1] === '') body.pop() // prázdny riadok pred ďalším oddeľovačom
  if (!body.some((l) => l.length)) return null
  const message = canonicalize(Buffer.from(body.map((l) => (/^>+From /.test(l) ? l.slice(1) : l)).join('\r\n') + '\r\n', 'latin1'))
  const { block, original, hashOk } = stripDoarBlock(message)
  const headers = headerMap(original)

  let flags: Set<string>
  let internalDate: Date | null
  if (block) {
    flags = block.flags
    internalDate = block.internalDate ?? separatorDate(sepLine)
  } else {
    // Cudzí mbox: stav z hlavičiek Status / X-Status (Thunderbird, mutt…).
    flags = new Set()
    const status = headers.get('status') ?? ''
    const x = headers.get('x-status') ?? ''
    if (status.includes('R')) flags.add('\\Seen')
    if (x.includes('A')) flags.add('\\Answered')
    if (x.includes('F')) flags.add('\\Flagged')
    if (x.includes('T')) flags.add('\\Draft')
    internalDate = separatorDate(sepLine)
  }
  if (!internalDate) {
    const d = Date.parse(headers.get('date') ?? '')
    internalDate = Number.isNaN(d) ? null : new Date(d)
  }
  const dateHeader = Date.parse(headers.get('date') ?? '')
  return {
    original,
    doar: !!block,
    hashOk,
    source: block?.headers.get('x-doar-source') || null,
    folderSegments: block ? block.folderSegments : null,
    specialUse: block?.specialUse ?? null,
    gmailLabels: block?.gmailLabels ?? [],
    flags,
    internalDate,
    fingerprint: sha256(original),
    size: original.length,
    weakKey: weakKey(normMessageId(headers.get('message-id')), Number.isNaN(dateHeader) ? null : dateHeader, fromAddress(headers.get('from')))
  }
}

/** Rýchly náhľad súboru: prvá správa (je to záloha Doar? z ktorého konta?). */
export async function peekMbox(path: string): Promise<{ doar: boolean; source: string | null }> {
  for await (const e of readMbox(path)) {
    const p = parseEntry(e.raw)
    if (p) return { doar: p.doar, source: p.source }
  }
  return { doar: false, source: null }
}
