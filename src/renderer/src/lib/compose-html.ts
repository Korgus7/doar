/**
 * Pomocné funkcie pre okno správy: text ↔ HTML editora, citácia, podpis.
 * HTML editora je jednoduché (odseky, zoznamy, citácie, odkazy) – jadro ho pred odoslaním aj tak znova prečistí.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Čistý text → odseky (prázdny riadok = nový odsek, riadok = zalomenie); riadky „> “ → citácia. */
export function textToHtml(text: string): string {
  const out: string[] = []
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines.every((l) => /^>/.test(l))) {
      const inner = lines.map((l) => l.replace(/^> ?/, '')).join('\n')
      out.push(`<blockquote>${textToHtml(inner)}</blockquote>`)
    } else out.push(`<p>${lines.map(escapeHtml).join('<br>')}</p>`)
  }
  return out.join('')
}

/** Podpis ako posledný odsek („--“ + riadky). */
export function signatureHtml(signature: string): string {
  const sig = signature.trim()
  return sig ? `<p>--<br>${sig.split(/\r?\n/).map(escapeHtml).join('<br>')}</p>` : ''
}

export function quoteHtml(header: string, text: string): string {
  return `<p>${escapeHtml(header)}</p><blockquote>${textToHtml(text.replace(/\s+$/, ''))}</blockquote>`
}

/** HTML editora → čistý text (pri prepnutí na čistý text). Rovnaké pravidlá ako textová podoba v jadre. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const lines: string[] = []
  const walk = (node: Node, quote: number, list: { ordered: boolean; n: number } | null, depth: number): void => {
    const prefix = '> '.repeat(quote)
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue
      const el = child as HTMLElement
      const tag = el.tagName.toLowerCase()
      if (tag === 'p' || /^h[1-6]$/.test(tag) || tag === 'pre') {
        for (const l of inline(el).split('\n')) lines.push(prefix + (l.trim() === '--' ? '-- ' : l))
        if (!list) lines.push(prefix.trimEnd())
      } else if (tag === 'blockquote') {
        walk(el, quote + 1, null, depth)
        lines.push(prefix.trimEnd())
      } else if (tag === 'ul' || tag === 'ol') {
        walk(el, quote, { ordered: tag === 'ol', n: 0 }, list ? depth + 1 : 0)
        if (!list) lines.push(prefix.trimEnd())
      } else if (tag === 'li' && list) {
        list.n++
        const marker = `${'  '.repeat(depth)}${list.ordered ? `${list.n}. ` : '- '}`
        const before = lines.length
        walk(el, quote, list, depth)
        if (lines.length > before) lines[before] = prefix + marker + lines[before]!.slice(prefix.length)
        else lines.push(prefix + marker)
      } else if (tag === 'hr') {
        lines.push(prefix + '---', prefix.trimEnd())
      } else walk(el, quote, list, depth)
    }
  }
  const inline = (el: HTMLElement): string => {
    let s = ''
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) s += n.textContent ?? ''
      else if (n.nodeType === 1) {
        const c = n as HTMLElement
        const tag = c.tagName.toLowerCase()
        if (tag === 'br') s += '\n'
        else if (tag === 'a') {
          const t = (c.textContent ?? '').trim()
          const href = (c.getAttribute('href') ?? '').replace(/^mailto:/i, '')
          s += !t ? href : t === href || !href ? t : `${t} <${href}>`
        } else s += inline(c)
      }
    }
    return s
  }
  walk(doc.body, 0, null, 0)
  while (lines.length && /^[>\s]*$/.test(lines[lines.length - 1]!)) lines.pop()
  return lines.filter((l, i) => !(/^[>\s]*$/.test(l) && /^[>\s]*$/.test(lines[i - 1] ?? 'x') && l === lines[i - 1])).join('\n')
}

/** Má HTML nejaké formátovanie (okrem odsekov a zalomení)? Pri prepnutí na čistý text by sa stratilo. */
export function hasFormatting(html: string): boolean {
  return /<(strong|b|em|i|u|s|a|ul|ol|blockquote|h[1-6]|code|pre|hr)\b/i.test(html)
}

/** Je obsah editora prázdny (len prázdne odseky)? */
export function htmlIsEmpty(html: string): boolean {
  return !html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
}
