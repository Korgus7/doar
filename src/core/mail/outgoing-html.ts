import sanitizeHtml from 'sanitize-html'
import { EDITOR_FONTS } from '../../shared/ipc'

/**
 * Formátovaná správa z okna na písanie (editor TipTap) → bezpečné HTML na odoslanie a textová podoba.
 *
 * Rozhranie nepovažujeme za dôveryhodné: HTML sa vždy znova prečistí na úzku množinu značiek, ktoré editor
 * vie vytvoriť. Textová podoba (multipart/alternative) zachová štruktúru – odseky, zoznamy, citácie, odkazy.
 */

const TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'hr', 'code', 'pre', 'img', 'span', 'table', 'tbody', 'tr', 'td']
/** Formátovanie z editora: na span farba, zvýraznenie, veľkosť a písmo; na odseku a nadpise zarovnanie a zarážka. */
const BLOCK_STYLE = { 'text-align': [/^(left|center|right|justify)$/], 'padding-left': [/^\d{1,3}px$/] }
const SPAN_STYLES = {
  span: { color: [/^#[0-9a-f]{6}$/i], 'background-color': [/^#[0-9a-f]{6}$/i], 'font-size': [/^\d{1,2}(\.\d)?(px|pt)$/], 'font-family': [/^'[A-Za-z ]+'$/] },
  p: BLOCK_STYLE,
  h1: BLOCK_STYLE,
  h2: BLOCK_STYLE,
  h3: BLOCK_STYLE
}

/** Obrázok v správe (logo v podpise): len vložený obrázok data: (PNG, JPEG, GIF, WebP), nie odkaz na internet. */
const IMG_SRC = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i
/** Najväčší vložený obrázok (bajty base64). */
const MAX_IMG = 700_000
const imgFilter = (frame: { tag: string; attribs: Record<string, string> }): boolean =>
  frame.tag === 'img' && !(IMG_SRC.test(frame.attribs['src'] ?? '') && (frame.attribs['src'] ?? '').length <= MAX_IMG)
/** Šírka a výška obrázka: len čísla (pixely), najviac 2000. */
function cleanImg(attribs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { src: attribs['src'] ?? '' }
  if (attribs['alt']) out['alt'] = attribs['alt'].slice(0, 200)
  for (const k of ['width', 'height']) {
    const n = Number.parseInt(attribs[k] ?? '', 10)
    if (Number.isFinite(n) && n > 0 && n <= 2000) out[k] = String(n)
  }
  return out
}

/**
 * Formátovanie textu z editora: farba (prehliadač ju zapíše ako `rgb(…)` – prevedie sa na #rrggbb), veľkosť
 * (pt alebo px) a písmo zo zoznamu editora. Všetko ostatné zo štýlu sa zahodí.
 */
function toHex(v: string): string | null {
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  const m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(s)
  return m ? `#${m.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}` : null
}
function cleanSpan(attribs: Record<string, string>): Record<string, string> {
  const out: string[] = []
  for (const decl of (attribs['style'] ?? '').split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    if (prop === 'font-size') {
      // Veľkosť písma z editora: pt (ako Outlook, 6–72) alebo px (8–96).
      const m = /^\s*(\d{1,2}(?:\.\d)?)(pt|px)\s*$/i.exec(decl.slice(i + 1))
      const n = m ? Number(m[1]) : 0
      const unit = m?.[2]?.toLowerCase()
      const ok = unit === 'pt' ? n >= 6 && n <= 72 : n >= 8 && n <= 96
      if (ok && !out.some((x) => x.startsWith('font-size:'))) out.push(`font-size:${n}${unit}`)
      continue
    }
    if (prop === 'font-family') {
      // Písmo: len zo zoznamu editora (prvé uvedené).
      const first = decl.slice(i + 1).split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').toLowerCase()
      const font = EDITOR_FONTS.find((f) => f.toLowerCase() === first)
      if (font && !out.some((x) => x.startsWith('font-family:'))) out.push(`font-family:'${font}'`)
      continue
    }
    const hex = toHex(decl.slice(i + 1))
    if (hex && (prop === 'color' || prop === 'background-color') && !out.some((x) => x.startsWith(`${prop}:`))) out.push(`${prop}:${hex}`)
  }
  return out.length ? { style: out.join(';') } : {}
}

/** Zarovnanie a zarážka odseku alebo nadpisu z editora (Graph/Outlook ich zobrazia ako inline štýl). */
function blockStyle(attribs: Record<string, string>): string {
  const out: string[] = []
  for (const decl of (attribs['style'] ?? '').split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const v = decl.slice(i + 1).trim().toLowerCase()
    if (prop === 'text-align' && ['left', 'center', 'right', 'justify'].includes(v)) out.push(`text-align:${v}`)
    if (prop === 'padding-left') {
      const n = /^(\d{1,3})px$/.exec(v)
      if (n && Number(n[1]) > 0 && Number(n[1]) <= 400) out.push(`padding-left:${Number(n[1])}px`)
    }
  }
  return out.join(';')
}
const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3']

/** Smer textu (dir) – editor ho dáva každému odseku, aby sa hebrejčina zobrazila sprava doľava aj u príjemcu. */
const DIR_TAGS = ['p', 'li', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'pre']
const DIR_VALUES = ['ltr', 'rtl', 'auto']
const withDir = (extra: Record<string, string[]> = {}): Record<string, string[]> => {
  const out: Record<string, string[]> = { a: ['href'], img: ['src', 'alt', 'width', 'height'], span: ['style'], td: ['colspan', 'rowspan', ...(extra['td'] ?? [])], table: [...(extra['table'] ?? [])] }
  for (const t of DIR_TAGS) out[t] = ['dir', ...(BLOCK_TAGS.includes(t) ? ['style'] : []), ...(extra[t] ?? [])]
  return out
}
/** Ponechá len platnú hodnotu dir (ltr, rtl, auto). */
function cleanDir(attribs: Record<string, string>): Record<string, string> {
  const { dir, ...rest } = attribs
  return dir && DIR_VALUES.includes(dir.toLowerCase()) ? { ...rest, dir: dir.toLowerCase() } : rest
}
const dirTransforms: Record<string, (tagName: string, attribs: Record<string, string>) => { tagName: string; attribs: Record<string, string> }> = {
  ...Object.fromEntries(DIR_TAGS.map((t) => [t, (tagName: string, attribs: Record<string, string>) => ({ tagName, attribs: cleanDir(attribs) })])),
  ...Object.fromEntries(
    BLOCK_TAGS.map((t) => [
      t,
      (tagName: string, attribs: Record<string, string>) => {
        const { style: _s, ...rest } = cleanDir(attribs)
        const st = blockStyle(attribs)
        return { tagName, attribs: st ? { ...rest, style: st } : rest }
      }
    ])
  ),
  img: (tagName, attribs) => ({ tagName, attribs: cleanImg(attribs) }),
  span: (tagName, attribs) => ({ tagName, attribs: cleanSpan(attribs) }),
  // Tabuľka z editora: bunky môžu byť zlúčené (colspan/rowspan 2–20), iné atribúty nie. Bunka hlavičky (th) = bunka.
  th: (_tagName, attribs) => ({ tagName: 'td', attribs: cleanCell(attribs) }),
  td: (tagName, attribs) => ({ tagName, attribs: cleanCell(attribs) }),
  table: (tagName) => ({ tagName, attribs: {} })
}
function cleanCell(attribs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ['colspan', 'rowspan']) {
    const n = Number.parseInt(attribs[k] ?? '', 10)
    if (n >= 2 && n <= 20) out[k] = String(n)
  }
  return out
}
/** Tabuľka v odoslanej správe: čiary a odsadenie ako inline štýl (Gmail a Outlook iné štýly nepoznajú). */
const TABLE_STYLE = 'border-collapse:collapse;margin:0 0 0.6em'
const CELL_STYLE = 'border:1px solid #9aa4b2;padding:4px 8px;vertical-align:top'

const QUOTE_STYLE = 'margin:0 0 0 0.8ex;border-left:2px solid #c9d1dc;padding-left:1ex;color:#4a5361'

/**
 * Pozadie celej správy: editor ho posiela ako obal `<div data-doar-bg="#rrggbb">…</div>`; v odoslanej správe
 * je ten istý atribút na hlavnom bloku hneď za <body> (koncept zo servera si ho tak zachová).
 */
const PAGE_BG = /^(?:\s|<!doctype[^>]*>|<html[^>]*>|<head[^>]*>[\s\S]*?<\/head>|<body[^>]*>)*<div data-doar-bg="(#[0-9a-f]{6})"/i
export function pageBackgroundOf(html: string): string | null {
  return PAGE_BG.exec(String(html ?? ''))?.[1]?.toLowerCase() ?? null
}

/** Prečistí HTML z editora (aj koncept z iného programu) na značky, ktoré Doar vie upravovať a odoslať. */
export function sanitizeComposeHtml(html: string): string {
  const bg = pageBackgroundOf(html)
  const clean = cleanCompose(html)
  return bg ? `<div data-doar-bg="${bg}">${clean}</div>` : clean
}

function cleanCompose(html: string): string {
  return sanitizeHtml(String(html ?? '').slice(0, 5_000_000), {
    allowedTags: TAGS,
    allowedAttributes: withDir(),
    allowedStyles: SPAN_STYLES,
    transformTags: dirTransforms,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    exclusiveFilter: imgFilter,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head', 'template', 'iframe', 'object', 'embed', 'svg', 'math']
  }).trim()
}

/** HTML na odoslanie: prečistené, s jednoduchým štýlom, ktorý funguje aj v programoch bez CSS v hlavičke. */
export function outgoingHtml(html: string): string {
  const bg = pageBackgroundOf(html)
  const body = sanitizeHtml(cleanCompose(html), {
    allowedTags: TAGS,
    allowedAttributes: withDir({ blockquote: ['style'], table: ['style'], td: ['style'] }),
    allowedStyles: { ...SPAN_STYLES, p: { ...BLOCK_STYLE, margin: [/^0 0 0\.6em$/] } },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    transformTags: {
      ...dirTransforms,
      blockquote: (tagName, attribs) => ({ tagName, attribs: { ...cleanDir(attribs), style: QUOTE_STYLE } }),
      table: (tagName) => ({ tagName, attribs: { style: TABLE_STYLE } }),
      td: (tagName, attribs) => ({ tagName, attribs: { ...cleanCell(attribs), style: CELL_STYLE } }),
      p: (tagName, attribs) => {
        const st = blockStyle(attribs)
        return { tagName, attribs: { ...cleanDir(attribs), style: `margin:0 0 0.6em${st ? `;${st}` : ''}` } }
      }
    }
  })
  const font = 'font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5'
  if (!bg) return `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="${font}">${body}</div></body></html>`
  // Farba aj na <body> (programy, ktoré ho zobrazia celé) aj na hlavnom bloku (Gmail štýl <body> zahodí).
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background-color:${bg}"><div data-doar-bg="${bg}" style="background-color:${bg};color:#1f2328;padding:16px 20px;${font}">${body}</div></body></html>`
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/**
 * Textová podoba prečisteného HTML z editora: odseky oddelené prázdnym riadkom, „- “ a „1. “ v zoznamoch,
 * „> “ pri citácii, odkaz ako „text <adresa>“ (ak sa líšia).
 */
export function htmlToText(html: string): string {
  const clean = sanitizeComposeHtml(html)
  const lines: string[] = []
  let line = ''
  let quote = 0
  const lists: { ordered: boolean; n: number }[] = []
  let href: string | null = null
  let linkText = ''
  let pre = false
  /** Tabuľka: bunky riadka v jednom riadku textu oddelené „ | “. */
  let cells = 0
  let rowCells = 0

  const prefix = (): string => '> '.repeat(quote)
  const flush = (): void => {
    // „-- “ (oddeľovač podpisu) si medzeru na konci musí nechať (editor ju v HTML stráca).
    if (line.length) lines.push(prefix() + (line.trim() === '--' ? '-- ' : line.replace(/[ \t]+$/g, '')))
    line = ''
  }
  /** Riadok obsahuje len značku položky zoznamu („- “, „2. “) – odsek v položke ju nesmie oddeliť. */
  const onlyMarker = (): boolean => /^\s*(-|\d+\.) $/.test(line)
  const blank = (): void => {
    flush()
    if (lines.length && lines[lines.length - 1] !== prefix().trimEnd()) lines.push(prefix().trimEnd())
  }

  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    if (m[4] !== undefined) {
      const text = decode(pre ? m[4] : m[4].replace(/\s+/g, ' '))
      if (href !== null) linkText += text
      else if (pre) {
        const parts = text.split('\n')
        line += parts[0]
        for (const p of parts.slice(1)) {
          flush()
          line = p
        }
      } else line += line.length || text.trim() ? text : ''
      continue
    }
    const close = m[1] === '/'
    const tag = m[2]!.toLowerCase()
    // Odseky a zalomenia v bunke tabuľky: len medzera (bunka zostane v riadku tabuľky).
    if (cells > 0 && ['p', 'h1', 'h2', 'h3', 'br'].includes(tag)) {
      if (!close && line && !line.endsWith(' ')) line += ' '
      continue
    }
    switch (tag) {
      case 'table':
        flush()
        if (close) blank()
        break
      case 'tr':
        flush()
        rowCells = 0
        break
      case 'td':
        if (close) cells = Math.max(0, cells - 1)
        else {
          if (rowCells++ > 0) line = line.replace(/ +$/, '') + ' | '
          cells++
        }
        break
      case 'br':
        flush()
        break
      case 'p':
      case 'h1':
      case 'h2':
      case 'h3':
        if (close) {
          if (lists.length) flush()
          else blank()
        } else if (!onlyMarker()) flush()
        break
      case 'pre':
        pre = !close
        if (close) blank()
        else flush()
        break
      case 'hr':
        flush()
        lines.push(prefix() + '---')
        blank()
        break
      case 'blockquote':
        flush()
        quote = Math.max(0, quote + (close ? -1 : 1))
        if (close) blank()
        break
      case 'ul':
      case 'ol':
        flush()
        if (close) {
          lists.pop()
          if (!lists.length) blank()
        } else lists.push({ ordered: tag === 'ol', n: 0 })
        break
      case 'li':
        if (close) flush()
        else {
          flush()
          const l = lists[lists.length - 1]
          const indent = '  '.repeat(Math.max(0, lists.length - 1))
          if (l) l.n++
          line = `${indent}${l?.ordered ? `${l.n}. ` : '- '}`
        }
        break
      case 'a':
        if (!close) {
          href = /href="([^"]*)"/i.exec(m[3] ?? '')?.[1] ?? ''
          href = decode(href)
          linkText = ''
        } else if (href !== null) {
          const t = linkText.trim()
          const target = href.replace(/^mailto:/i, '')
          line += !t ? target : t === target || !href ? t : `${t} <${target}>`
          href = null
        }
        break
      default:
        break
    }
  }
  flush()
  while (lines.length && /^[>\s]*$/.test(lines[lines.length - 1]!)) lines.pop()
  // Najviac jeden prázdny riadok za sebou.
  return lines.filter((l, i) => !(l.trim() === '' && (lines[i - 1] ?? '').trim() === '')).join('\n')
}

/**
 * Vložené obrázky (data:) → prílohy s Content-ID (multipart/related): logo v podpise uvidí príjemca aj v Gmaile
 * a Outlooku, ktoré obrázky data: v pošte nezobrazujú. Rovnaký obrázok sa priloží len raz.
 */
export function inlineImages(html: string, domain = 'doar.local'): { html: string; images: { filename: string; content: Buffer; contentType: string; cid: string }[] } {
  const images: { filename: string; content: Buffer; contentType: string; cid: string }[] = []
  const seen = new Map<string, string>()
  const out = html.replace(/(<img\b[^>]*?\bsrc=")(data:image\/(png|jpe?g|gif|webp);base64,([^"]+))(")/gi, (_m, pre: string, uri: string, kind: string, b64: string, post: string) => {
    let cid = seen.get(uri)
    if (!cid) {
      cid = `obrazok${images.length + 1}.${Date.now().toString(36)}@${domain}`
      const ext = kind.toLowerCase() === 'jpg' ? 'jpeg' : kind.toLowerCase()
      images.push({ filename: `obrazok${images.length + 1}.${ext === 'jpeg' ? 'jpg' : ext}`, content: Buffer.from(b64.replace(/\s+/g, ''), 'base64'), contentType: `image/${ext}`, cid })
      seen.set(uri, cid)
    }
    return `${pre}cid:${cid}${post}`
  })
  return { html: out, images }
}
