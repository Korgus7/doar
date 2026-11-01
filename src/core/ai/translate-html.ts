/**
 * Preklad správy priamo v jej HTML (ako „Preložiť správu“ v Outlooku): rozloženie, obrázky, tabuľky aj odkazy
 * zostanú, preloží sa len text.
 *
 * HTML (už prečistené pre zobrazenie) sa rozdelí na úseky textu medzi blokovými značkami. Do AI ide len text
 * úsekov; vnútorné značky (tučné, odkaz…) a zalomenia riadkov sú v ňom nahradené krátkymi značkami <t1>…</t1>,
 * takže adresy odkazov ani obrázky AI nevidí a nemôže pridať vlastné. Po preklade sa značky vrátia na miesto,
 * všetko ostatné z odpovede sa zobrazí len ako text.
 */

/** Značky, ktoré zostanú vnútri úseku (súčasť vety). Ostatné úsek ukončia. */
const INLINE = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'span', 'font', 'small', 'big', 'sub', 'sup', 'mark', 'abbr', 'cite', 'q', 'code', 'del', 'ins', 'br', 'wbr'])
/** Obsah týchto značiek sa neprekladá. */
const SKIP = new Set(['style', 'script', 'title', 'head', 'pre'])

export interface Segment {
  /** Text pre AI so značkami <tN>, </tN>, <tN/>. */
  text: string
  /** Pôvodné HTML pre značku tN (index N−1); „\n“ = zalomenie riadku. */
  tokens: string[]
}

export interface Segmented {
  /** HTML s miestami pre úseky (\u0000N\u0000). */
  template: string
  segments: Segment[]
}

const LETTER = /\p{L}/u
const decodeBasic = (s: string): string => s.replace(/&nbsp;|&#160;/gi, ' ').replace(/&[a-z]+;|&#\d+;/gi, 'x')

export function segmentHtml(html: string): Segmented {
  const out: string[] = []
  const segments: Segment[] = []
  let buf: { tag: boolean; raw: string }[] = []
  let skip: string | null = null

  const emitGroup = (g: { tag: boolean; raw: string }[]): void => {
    if (!g.some((it) => !it.tag && LETTER.test(decodeBasic(it.raw)))) {
      out.push(g.map((it) => it.raw).join(''))
      return
    }
    const tokens: string[] = []
    let s = ''
    for (const it of g) {
      if (it.tag) {
        tokens.push(it.raw)
        const n = tokens.length
        if (/^<\//.test(it.raw)) s += `</t${n}>`
        else if (/^<(br|wbr)\b/i.test(it.raw) || /\/>$/.test(it.raw)) s += `<t${n}/>`
        else s += `<t${n}>`
      } else {
        s += it.raw.replace(/\r?\n/g, () => {
          tokens.push('\n')
          return `<t${tokens.length}/>`
        })
      }
    }
    // Medzery na krajoch zostanú v HTML (pri čistom texte sú to zalomenia riadkov).
    const m = /^((?:\s|<t\d+\/>)*?)([\s\S]*?)((?:\s|<t\d+\/>)*)$/.exec(s)!
    const restore = (part: string): string => part.replace(/<t(\d+)\/>/g, (_x, n: string) => tokens[Number(n) - 1] ?? '')
    segments.push({ text: m[2]!, tokens })
    out.push(restore(m[1]!) + `\u0000${segments.length - 1}\u0000` + restore(m[3]!))
  }

  const flush = (): void => {
    if (!buf.length) return
    // Prázdny riadok v texte (čistý text, odseky) = nový úsek.
    const groups: { tag: boolean; raw: string }[][] = [[]]
    const seps: string[] = []
    for (const it of buf) {
      if (it.tag) {
        groups[groups.length - 1]!.push(it)
        continue
      }
      it.raw.split(/(\r?\n[ \t]*\r?\n\s*)/).forEach((p, i) => {
        if (i % 2 === 1) {
          seps.push(p)
          groups.push([])
        } else if (p) groups[groups.length - 1]!.push({ tag: false, raw: p })
      })
    }
    groups.forEach((g, i) => {
      if (i > 0) out.push(seps[i - 1]!)
      emitGroup(g)
    })
    buf = []
  }

  for (const piece of html.split(/(<!--[\s\S]*?-->|<[^>]*>)/)) {
    if (!piece) continue
    if (piece.startsWith('<')) {
      const m = /^<(\/?)([a-zA-Z][\w-]*)/.exec(piece)
      const name = m?.[2]?.toLowerCase() ?? ''
      if (skip) {
        out.push(piece)
        if (m?.[1] === '/' && name === skip) skip = null
        continue
      }
      if (m && INLINE.has(name)) {
        buf.push({ tag: true, raw: piece })
        continue
      }
      flush()
      out.push(piece)
      if (m && !m[1] && SKIP.has(name) && !/\/>$/.test(piece)) skip = name
      continue
    }
    if (skip) out.push(piece)
    else buf.push({ tag: false, raw: piece })
  }
  flush()
  return { template: out.join(''), segments }
}

const esc = (s: string): string => s.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Preložený text úseku → HTML: značky tN sa vrátia, všetko ostatné je len text. */
export function restoreSegment(seg: Segment, translated: string): string {
  return translated
    .split(/(<\/?t\d+\/?>)/)
    .map((part) => {
      const t = /^<\/?t(\d+)\/?>$/.exec(part)
      if (t) return seg.tokens[Number(t[1]) - 1] ?? ''
      return esc(part)
    })
    .join('')
}

/** Odpoveď AI „⟦N⟧ text“ (riadok na úsek) → preklady podľa čísla. */
export function parseNumbered(out: string): Map<number, string> {
  const map = new Map<number, string>()
  let last: number | null = null
  for (const line of out.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*⟦(\d+)⟧\s?(.*)$/.exec(line)
    if (m) {
      last = Number(m[1])
      map.set(last, m[2]!.trim())
    } else if (last !== null && line.trim()) map.set(last, `${map.get(last)} ${line.trim()}`)
  }
  return map
}

/** Zloží preložené HTML; chýbajúci preklad = pôvodný text úseku. */
export function rebuildHtml(s: Segmented, translations: Map<number, string>, offset = 1): string {
  return s.template.replace(/\u0000(\d+)\u0000/g, (_x, n: string) => {
    const seg = s.segments[Number(n)]!
    const tr = translations.get(Number(n) + offset)
    return restoreSegment(seg, tr && tr.trim() ? tr : seg.text)
  })
}
