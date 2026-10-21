import sanitizeHtml from 'sanitize-html'

/**
 * Sanitizácia HTML pošty. HTML z e-mailu je nedôveryhodné:
 *  - žiadne skripty, formuláre, iframy, objekty, meta/base/link,
 *  - žiadne on* atribúty ani javascript: odkazy,
 *  - vzdialené obrázky sa odstránia (počítajú sa), pokiaľ ich jadro samo nestiahlo a nevložilo ako data: URI,
 *  - obrázky cid: sa nahradia vloženými prílohami.
 * Druhou vrstvou ochrany je prísny CSP v izolovanom iframe rozhrania.
 */

export interface SanitizeOptions {
  /** cid → data: URI (vložené obrázky z príloh). */
  cid: Map<string, string>
  /** URL vzdialeného obrázka → data: URI (len ak používateľ povolil vzdialený obsah). */
  remote: Map<string, string> | null
}

export interface SanitizeResult {
  html: string
  /** Vzdialené obrázky, ktoré sa nezobrazili. */
  blocked: number
  /** Všetky vzdialené URL obrázkov (na stiahnutie po povolení). */
  remoteUrls: string[]
}

const TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img', 'style', 'font', 'center', 'span', 'div', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup',
  'caption', 'hr', 'br', 'u', 's', 'strike', 'sub', 'sup', 'small', 'big', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code',
  'blockquote', 'abbr', 'address', 'cite', 'del', 'ins', 'mark', 'q', 'wbr'
]

const COMMON_ATTRS = [
  'style', 'class', 'id', 'dir', 'lang', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'border',
  'cellpadding', 'cellspacing', 'title', 'colspan', 'rowspan', 'face', 'size', 'role', 'aria-hidden', 'nowrap'
]

export function sanitizeEmailHtml(html: string, opts: SanitizeOptions): SanitizeResult {
  let blocked = 0
  const remoteUrls = new Set<string>()
  const out = sanitizeHtml(html, {
    allowedTags: TAGS,
    allowVulnerableTags: true, // <style> – CSS nemôže spúšťať kód; vzdialené načítanie blokuje CSP
    allowedAttributes: {
      '*': COMMON_ATTRS,
      a: ['href', 'name'],
      img: ['src', 'alt', 'width', 'height', 'data-doar-remote']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data', 'cid', 'http', 'https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'head', 'template', 'iframe', 'object', 'embed', 'applet', 'svg', 'math'],
    transformTags: {
      img: (tagName, attribs) => {
        const src = (attribs['src'] ?? '').trim()
        const next = { ...attribs }
        if (/^cid:/i.test(src)) {
          const id = src.slice(4).replace(/^<|>$/g, '').toLowerCase()
          next['src'] = opts.cid.get(id) ?? ''
        } else if (/^https?:/i.test(src)) {
          remoteUrls.add(src)
          const inlined = opts.remote?.get(src)
          if (inlined) next['src'] = inlined
          else {
            blocked++
            next['src'] = ''
            next['data-doar-remote'] = '1'
          }
        } else if (!/^data:image\//i.test(src)) {
          next['src'] = ''
        }
        return { tagName, attribs: next }
      },
      a: (tagName, attribs) => {
        const next: Record<string, string> = {}
        if (attribs['href']) next['href'] = attribs['href']
        if (attribs['name']) next['name'] = attribs['name']
        return { tagName, attribs: next }
      }
    }
  })
  return { html: out, blocked, remoteUrls: [...remoteUrls] }
}

const URL_RE = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g

/** Čistý text → bezpečné HTML s klikateľnými odkazmi. */
export function textToHtml(text: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  let out = ''
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    out += esc(text.slice(last, m.index))
    out += `<a href="${esc(m[1]!)}">${esc(m[1]!)}</a>`
    last = (m.index ?? 0) + m[0].length
  }
  out += esc(text.slice(last))
  return `<div class="doar-plain">${out}</div>`
}
