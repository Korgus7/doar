import sanitizeHtml from 'sanitize-html'

/**
 * Formátovaná správa z okna na písanie (editor TipTap) → bezpečné HTML na odoslanie a textová podoba.
 *
 * Rozhranie nepovažujeme za dôveryhodné: HTML sa vždy znova prečistí na úzku množinu značiek, ktoré editor
 * vie vytvoriť. Textová podoba (multipart/alternative) zachová štruktúru – odseky, zoznamy, citácie, odkazy.
 */

const TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'hr', 'code', 'pre']

/** Smer textu (dir) – editor ho dáva každému odseku, aby sa hebrejčina zobrazila sprava doľava aj u príjemcu. */
const DIR_TAGS = ['p', 'li', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'pre']
const DIR_VALUES = ['ltr', 'rtl', 'auto']
const withDir = (extra: Record<string, string[]> = {}): Record<string, string[]> => {
  const out: Record<string, string[]> = { a: ['href'] }
  for (const t of DIR_TAGS) out[t] = ['dir', ...(extra[t] ?? [])]
  return out
}
/** Ponechá len platnú hodnotu dir (ltr, rtl, auto). */
function cleanDir(attribs: Record<string, string>): Record<string, string> {
  const { dir, ...rest } = attribs
  return dir && DIR_VALUES.includes(dir.toLowerCase()) ? { ...rest, dir: dir.toLowerCase() } : rest
}
const dirTransforms = Object.fromEntries(DIR_TAGS.map((t) => [t, (tagName: string, attribs: Record<string, string>) => ({ tagName, attribs: cleanDir(attribs) })]))

const QUOTE_STYLE = 'margin:0 0 0 0.8ex;border-left:2px solid #c9d1dc;padding-left:1ex;color:#4a5361'

/** Prečistí HTML z editora (aj koncept z iného programu) na značky, ktoré Doar vie upravovať a odoslať. */
export function sanitizeComposeHtml(html: string): string {
  return sanitizeHtml(String(html ?? '').slice(0, 5_000_000), {
    allowedTags: TAGS,
    allowedAttributes: withDir(),
    transformTags: dirTransforms,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head', 'template', 'iframe', 'object', 'embed', 'svg', 'math']
  }).trim()
}

/** HTML na odoslanie: prečistené, s jednoduchým štýlom, ktorý funguje aj v programoch bez CSS v hlavičke. */
export function outgoingHtml(html: string): string {
  const body = sanitizeHtml(sanitizeComposeHtml(html), {
    allowedTags: TAGS,
    allowedAttributes: withDir({ blockquote: ['style'], p: ['style'] }),
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      ...dirTransforms,
      blockquote: (tagName, attribs) => ({ tagName, attribs: { ...cleanDir(attribs), style: QUOTE_STYLE } }),
      p: (tagName, attribs) => ({ tagName, attribs: { ...cleanDir(attribs), style: 'margin:0 0 0.6em' } })
    }
  })
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">${body}</div></body></html>`
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
    switch (tag) {
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
