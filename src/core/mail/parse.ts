import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import type { Address, AttachmentInfo } from '../../shared/ipc'
import { sanitizeEmailHtml, textToHtml } from './sanitize'

/** Údaje pre zoznam a vyhľadávanie, vypočítané po stiahnutí originálu. */
export interface IndexInfo {
  snippet: string
  hasAttachments: boolean
  bodyText: string
}

const MAX_INLINE_IMAGE = 2 * 1024 * 1024

function parse(raw: Buffer): Promise<ParsedMail> {
  // skipHtmlToText: text si z HTML odvodíme sami (bez adries obrázkov a odkazov, bez veľkých písmen v nadpisoch).
  return simpleParser(raw, { skipHtmlToText: true, skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 5 * 1024 * 1024 })
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', euro: '€', copy: '©', reg: '®' }

/** HTML → čistý text pre náhľad a vyhľadávanie (nie na zobrazenie). */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<(head|style|script|title|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

function plainText(p: ParsedMail): string {
  if (typeof p.text === 'string' && p.text.trim()) return p.text
  return typeof p.html === 'string' ? htmlToPlain(p.html) : ''
}

function addresses(a: AddressObject | AddressObject[] | undefined): Address[] {
  if (!a) return []
  const list = Array.isArray(a) ? a : [a]
  const out: Address[] = []
  for (const obj of list) {
    for (const v of obj.value) {
      if (v.address) out.push({ name: v.name ?? '', address: v.address })
      for (const g of v.group ?? []) if (g.address) out.push({ name: g.name ?? '', address: g.address })
    }
  }
  return out
}

function realAttachments(p: ParsedMail): ParsedMail['attachments'] {
  // Vložené obrázky (cid) zobrazené v texte nie sú „prílohy“ pre používateľa.
  return p.attachments.filter((a) => !(a.related && a.contentId && (a.contentType ?? '').startsWith('image/')))
}

export interface AttachmentContent {
  filename: string
  contentType: string
  content: Buffer
}

/** Prílohy správy s obsahom – v rovnakom poradí (index) ako v `renderMessage`. */
export async function extractAttachments(raw: Buffer): Promise<AttachmentContent[]> {
  const p = await parse(raw)
  return realAttachments(p).map((a, index) => ({
    filename: a.filename ?? `priloha-${index + 1}`,
    contentType: a.contentType ?? 'application/octet-stream',
    content: a.content
  }))
}

export async function indexInfo(raw: Buffer): Promise<IndexInfo> {
  const p = await parse(raw)
  const text = plainText(p).replace(/\s+/g, ' ').trim()
  return {
    snippet: text.slice(0, 200),
    hasAttachments: realAttachments(p).length > 0,
    bodyText: text
  }
}

export interface Rendered {
  subject: string
  from: Address[]
  to: Address[]
  cc: Address[]
  replyTo: Address[]
  date: string | null
  html: string | null
  text: string
  attachments: AttachmentInfo[]
  remoteBlocked: number
  remoteUrls: string[]
}

/**
 * Pripraví správu na zobrazenie. `remote` = už stiahnuté vzdialené obrázky (URL → data: URI),
 * null = vzdialený obsah blokovaný.
 */
export async function renderMessage(raw: Buffer, remote: Map<string, string> | null): Promise<Rendered> {
  const p = await parse(raw)
  const cid = new Map<string, string>()
  for (const a of p.attachments) {
    if (a.contentId && (a.contentType ?? '').startsWith('image/') && a.content.length <= MAX_INLINE_IMAGE) {
      cid.set(a.contentId.replace(/^<|>$/g, '').toLowerCase(), `data:${a.contentType};base64,${a.content.toString('base64')}`)
    }
  }
  let html: string | null = null
  let blocked = 0
  let remoteUrls: string[] = []
  if (typeof p.html === 'string' && p.html.trim()) {
    const r = sanitizeEmailHtml(p.html, { cid, remote })
    html = r.html
    blocked = r.blocked
    remoteUrls = r.remoteUrls
  } else {
    html = textToHtml(p.text ?? '')
  }
  return {
    subject: p.subject ?? '',
    from: addresses(p.from),
    to: addresses(p.to),
    cc: addresses(p.cc),
    replyTo: addresses(p.replyTo),
    date: p.date ? p.date.toISOString() : null,
    html,
    text: plainText(p),
    attachments: realAttachments(p).map((a, index) => ({
      index,
      filename: a.filename ?? `priloha-${index + 1}`,
      contentType: a.contentType ?? 'application/octet-stream',
      size: a.size ?? a.content.length
    })),
    remoteBlocked: blocked,
    remoteUrls
  }
}
