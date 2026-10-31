<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import { Editor, Extension, Mark, Node, getHTMLFromFragment } from '@tiptap/core'
  import StarterKit from '@tiptap/starter-kit'
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { textToHtml } from '../lib/compose-html'
  import { EDITOR_FONTS } from '../../../shared/ipc'
  import type { Node as PmNode } from '@tiptap/pm/model'
  import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable, goToNextCell, isInTable, tableEditing } from '@tiptap/pm/tables'
  import type { Command } from '@tiptap/pm/state'

  /**
   * Editor formátovaného textu (TipTap), lišta ako v Outlooku: písmo, veľkosť, tučné, kurzíva, podčiarknutie,
   * prečiarknutie, zvýraznenie, farba písma, zoznamy, zarážka, zarovnanie, nadpis, citácia, odkaz, pozadie správy.
   * Všetko ako inline štýly, ktoré jadro prečistí a ktoré zobrazia aj iné poštové programy.
   */
  let {
    html,
    disabled = false,
    onchange,
    label,
    pageBackground = false
  }: { html: string; disabled?: boolean; onchange: (html: string) => void; label: string; pageBackground?: boolean } = $props()

  /**
   * Smer textu podľa obsahu každého odseku a nadpisu (hebrejčina sprava doľava, slovenčina zľava).
   * Len textové bloky – citácia a zoznamy majú smer rozhrania. dir="auto" ide aj do odoslanej správy.
   */
  const AutoDir = Extension.create({
    name: 'doarAutoDir',
    addGlobalAttributes() {
      return [
        {
          types: ['paragraph', 'heading'],
          attributes: {
            dir: {
              default: 'auto',
              parseHTML: (el) => (['ltr', 'rtl', 'auto'].includes(el.getAttribute('dir') ?? '') ? el.getAttribute('dir') : 'auto'),
              renderHTML: (attrs) => ({ dir: (attrs['dir'] as string | null) || 'auto' })
            },
            // Zarovnanie a zarážka (Outlook: Zarovnať, Zväčšiť zarážku) – inline štýl odseku.
            textAlign: {
              default: null,
              parseHTML: (el) => (['center', 'right', 'justify'].includes(el.style.textAlign) ? el.style.textAlign : null),
              renderHTML: (attrs) => (attrs['textAlign'] ? { style: `text-align:${attrs['textAlign'] as string}` } : {})
            },
            indent: {
              default: 0,
              parseHTML: (el) => Math.min(8, Math.max(0, Math.round((Number.parseInt(el.style.paddingLeft, 10) || 0) / 40))),
              renderHTML: (attrs) => (attrs['indent'] ? { style: `padding-left:${(attrs['indent'] as number) * 40}px` } : {})
            }
          }
        }
      ]
    }
  })

  /**
   * Vložený obrázok (logo v podpise): len data: URI – nič sa nesťahuje z internetu. Jadro ho pred odoslaním
   * prečistí a priloží ako obrázok s Content-ID.
   */
  const InlineImage = Node.create({
    name: 'image',
    inline: true,
    group: 'inline',
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        src: { default: null },
        alt: { default: null },
        width: { default: null },
        height: { default: null }
      }
    },
    parseHTML() {
      return [{ tag: 'img[src^="data:image/"]' }]
    },
    renderHTML({ HTMLAttributes }) {
      return ['img', HTMLAttributes]
    }
  })

  /**
   * Farby ako v Office: 10 farieb motívu, každá v 5 odtieňoch (svetlejšie a tmavšie), 10 štandardných farieb
   * a „Viac farieb…“ (ľubovoľná). Jadro pred odoslaním povolí farbu v tvare #rrggbb.
   */
  const THEME = ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47']
  const STANDARD = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0']
  /** Farby zvýrazňovača ako v Office. */
  const HIGHLIGHT = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#0000ff', '#ff0000', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0', '#000000']
  const hex2 = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
  const mix = (hex: string, f: number): string => {
    // f > 0: svetlejšie (k bielej), f < 0: tmavšie (k čiernej)
    const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
    return `#${c.map((v) => hex2(f > 0 ? v + (255 - v) * f : v * (1 + f))).join('')}`
  }
  /** Odtiene pod každou farbou motívu (riadky): biela tmavne, čierna svetlie, ostatné 3 svetlejšie a 2 tmavšie. */
  const SHADE_ROWS = [0, 1, 2, 3, 4].map((r) =>
    THEME.map((c, i) => (i === 0 ? mix(c, -[0.05, 0.15, 0.25, 0.35, 0.5][r]!) : i === 1 ? mix(c, [0.5, 0.35, 0.25, 0.15, 0.05][r]!) : mix(c, [0.8, 0.6, 0.4, -0.25, -0.5][r]!)))
  )
  /** Farba z HTML (#rrggbb alebo rgb(…)) → #rrggbb, inak null. */
  function normColor(value: string): string | null {
    const v = value.trim().toLowerCase()
    if (/^#[0-9a-f]{6}$/.test(v)) return v
    const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v)
    return rgb ? `#${rgb.slice(1, 4).map((n) => hex2(Number(n))).join('')}` : null
  }
  /**
   * Pozadie celej správy: tá istá paleta. V HTML z editora je to obal
   * `<div data-doar-bg="#rrggbb">…</div>` – jadro ho prečistí a pri odoslaní dá farbu na pozadie celej správy.
   */
  const PAGE_RE = /^\s*<div data-doar-bg="(#[0-9a-f]{6})">([\s\S]*)<\/div>\s*$/i
  let pageBg = $state<string | null>(null)
  /** HTML zvonku (koncept, šablóna) → obsah editora; obal s pozadím sa preberie do pageBg. */
  function unwrap(value: string): string {
    const m = PAGE_RE.exec(value)
    if (!m) return value
    if (pageBackground) pageBg = m[1]!.toLowerCase()
    return m[2]!
  }
  const wrap = (inner: string): string => (pageBackground && pageBg ? `<div data-doar-bg="${pageBg}">${inner}</div>` : inner)

  /** Značka s farbou z palety: písmo (`color`) alebo pozadie/zvýraznenie (`background-color`). */
  function colorMark(name: string, css: 'color' | 'background-color'): Mark {
    const read = (el: HTMLElement): string | null => normColor(el.style.getPropertyValue(css))
    return Mark.create({
      name,
      addAttributes() {
        return {
          color: {
            default: null,
            parseHTML: (el) => read(el as HTMLElement),
            renderHTML: (attrs) => (attrs['color'] ? { style: `${css}:${attrs['color'] as string}` } : {})
          }
        }
      },
      parseHTML() {
        // consuming: false – ten istý span môže niesť farbu písma aj pozadia.
        return [{ tag: 'span[style]', consuming: false, getAttrs: (el) => (read(el as HTMLElement) ? null : false) }]
      },
      renderHTML({ HTMLAttributes }) {
        return ['span', HTMLAttributes, 0]
      }
    })
  }
  const TextColor = colorMark('textColor', 'color')
  const TextBackground = colorMark('textBackground', 'background-color')

  /** Veľkosti písma ako v Outlooku (pt). Bez značky = predvolená veľkosť. */
  const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]
  /** Veľkosť z HTML: pt alebo px (staršie správy) v rozumnom rozsahu. */
  const sizeOf = (v: string): string | null => {
    const m = /^(\d{1,2}(?:\.\d)?)(pt|px)$/.exec(v.trim())
    return m && Number(m[1]) >= 6 && Number(m[1]) <= 96 ? `${Number(m[1])}${m[2]}` : null
  }
  /** Značka so štýlom na span (veľkosť, písmo). consuming: false – jeden span môže niesť viac štýlov. */
  function styleMark(name: string, attr: string, read: (el: HTMLElement) => string | null, css: (v: string) => string): Mark {
    return Mark.create({
      name,
      addAttributes() {
        return {
          [attr]: {
            default: null,
            parseHTML: (el) => read(el as HTMLElement),
            renderHTML: (attrs) => (attrs[attr] ? { style: css(attrs[attr] as string) } : {})
          }
        }
      },
      parseHTML() {
        return [{ tag: 'span[style]', consuming: false, getAttrs: (el) => (read(el as HTMLElement) ? null : false) }]
      },
      renderHTML({ HTMLAttributes }) {
        return ['span', HTMLAttributes, 0]
      }
    })
  }
  const FontSize = styleMark('fontSize', 'size', (el) => sizeOf(el.style.fontSize), (v) => `font-size:${v}`)
  const fontOf = (v: string): string | null => {
    const first = v.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').toLowerCase()
    return EDITOR_FONTS.find((f) => f.toLowerCase() === first) ?? null
  }
  const FontFamily = styleMark('fontFamily', 'family', (el) => fontOf(el.style.fontFamily), (v) => `font-family:'${v}'`)

  /**
   * Tabuľka (ako „Vložiť → Tabuľka“ v Outlooku): bunky s odsekmi, Tab = ďalšia bunka. Logika riadkov a stĺpcov
   * je z prosemirror-tables (súčasť @tiptap/pm). Čiary a odsadenie doplní jadro pri odoslaní (inline štýly).
   */
  const TableRoles = Extension.create({
    name: 'tableRoles',
    extendNodeSchema(ext) {
      const role = ({ table: 'table', tableRow: 'row', tableCell: 'cell' } as Record<string, string>)[ext.name]
      return role ? { tableRole: role } : {}
    }
  })
  const span = (name: string) => ({
    default: 1,
    parseHTML: (el: HTMLElement) => Math.min(20, Math.max(1, Number.parseInt(el.getAttribute(name) ?? '1', 10) || 1)),
    renderHTML: (attrs: Record<string, unknown>) => ((attrs[name] as number) > 1 ? { [name]: attrs[name] } : {})
  })
  const Table = Node.create({
    name: 'table',
    group: 'block',
    content: 'tableRow+',
    isolating: true,
    parseHTML: () => [{ tag: 'table' }],
    renderHTML: () => ['table', { class: 'doar-table' }, ['tbody', 0]],
    addProseMirrorPlugins: () => [tableEditing()],
    addKeyboardShortcuts() {
      const cmd = (c: Command) => () => (isInTable(this.editor.state) ? c(this.editor.state, this.editor.view.dispatch) : false)
      return { Tab: cmd(goToNextCell(1)), 'Shift-Tab': cmd(goToNextCell(-1)) }
    }
  })
  const TableRow = Node.create({
    name: 'tableRow',
    content: 'tableCell*',
    parseHTML: () => [{ tag: 'tr' }],
    renderHTML: () => ['tr', 0]
  })
  const TableCell = Node.create({
    name: 'tableCell',
    content: 'block+',
    isolating: true,
    addAttributes: () => ({ colspan: span('colspan'), rowspan: span('rowspan'), colwidth: { default: null, rendered: false } }),
    parseHTML: () => [{ tag: 'td' }, { tag: 'th' }],
    renderHTML: ({ HTMLAttributes }) => ['td', HTMLAttributes, 0]
  })

  let el: HTMLDivElement | undefined = $state()
  let editor: Editor | null = $state(null)
  /** Zmena stavu editora → prekreslenie tlačidiel (aktívne formátovanie). */
  let tickCount = $state(0)
  let linkOpen = $state(false)
  let linkUrl = $state('')
  let linkInput: HTMLInputElement | undefined = $state()

  onMount(() => {
    editor = new Editor({
      element: el!,
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3] },
          codeBlock: false,
          code: false,
          link: { openOnClick: false, autolink: true, protocols: ['mailto'], HTMLAttributes: { rel: null, target: null } }
        }),
        AutoDir,
        InlineImage,
        TextColor,
        TextBackground,
        FontSize,
        FontFamily,
        TableRoles,
        Table,
        TableRow,
        TableCell
      ],
      content: unwrap(html),
      editable: !disabled,

      editorProps: { attributes: { 'aria-label': label, 'aria-multiline': 'true', role: 'textbox', spellcheck: 'true', class: 'doar-editor' } },
      onUpdate: ({ editor: e }) => onchange(wrap(e.getHTML())),
      onTransaction: () => tickCount++
    })
  })

  onDestroy(() => editor?.destroy())

  $effect(() => {
    editor?.setEditable(!disabled)
  })

  export function focus(position: 'start' | 'end' = 'end'): void {
    editor?.commands.focus(position)
  }

  export function getHTML(): string {
    return editor ? wrap(editor.getHTML()) : html
  }

  export function setHTML(next: string): void {
    pageBg = null
    editor?.commands.setContent(unwrap(next), { emitUpdate: true })
  }

  const leafText = (leaf: PmNode): string => (leaf.type.name === 'hardBreak' ? '\n' : '')
  const between = (from: number, to: number): string => editor!.state.doc.textBetween(from, to, '\n\n', leafText)

  /** Koniec vlastného textu: pred podpisom („--“), citáciou (aj s hlavičkou) alebo preposlanou správou. */
  function ownEnd(): number {
    const doc = editor!.state.doc
    let end = doc.content.size
    let prev: { node: PmNode; offset: number } | null = null
    let found = false
    doc.forEach((node, offset) => {
      if (found) return
      const first = node.firstChild
      const signature = node.type.name === 'paragraph' && !!first?.isText && /^--\s?$/.test(first.text ?? '') && (node.childCount === 1 || node.child(1).type.name === 'hardBreak')
      const forward = node.type.name === 'paragraph' && /^-{5,}/.test(node.textContent)
      if (signature || forward) {
        end = offset
        found = true
      } else if (node.type.name === 'blockquote') {
        end = prev && prev.node.type.name === 'paragraph' && prev.node.textContent.trim() ? prev.offset : offset
        found = true
      }
      prev = { node, offset }
    })
    return end
  }

  /** Text pre AI: označený text, inak vlastný text správy (bez podpisu a citácie). */
  export function aiSource(): { text: string; from: number; to: number; selection: boolean } | null {
    if (!editor) return null
    const sel = editor.state.selection
    if (!sel.empty) return { text: between(sel.from, sel.to), from: sel.from, to: sel.to, selection: true }
    const to = ownEnd()
    return { text: between(0, to), from: 0, to, selection: false }
  }

  /** Vloží výsledok AI namiesto pôvodného textu (Ctrl+Z vráti späť). Ak sa text medzitým zmenil, vráti false. */
  export function aiApply(src: { text: string; from: number; to: number; selection: boolean }, result: string): boolean {
    if (!editor) return false
    if (src.to > editor.state.doc.content.size || between(src.from, src.to) !== src.text) return false
    const content = src.selection && !result.includes('\n') ? { type: 'text', text: result } : textToHtml(result)
    return editor.chain().focus().insertContentAt({ from: src.from, to: src.to }, content).run()
  }

  /** Vloží obrázok (data: URI) na miesto kurzora – logo v podpise. Široký obrázok sa zmenší na `width`. */
  export function insertImage(src: string, width?: number): void {
    editor
      ?.chain()
      .focus()
      .insertContent({ type: 'image', attrs: { src, ...(width ? { width } : {}) } })
      .run()
  }

  /** Úsek podpisu („--“ až po citáciu / preposlanú správu / koniec), alebo null. */
  function signatureRange(): { from: number; to: number } | null {
    const doc = editor!.state.doc
    let from: number | null = null
    let to = doc.content.size
    let prev: { node: PmNode; offset: number } | null = null
    doc.forEach((node, offset) => {
      const first = node.firstChild
      if (from === null) {
        if (node.type.name === 'paragraph' && !!first?.isText && /^--\s?$/.test(first.text ?? '') && (node.childCount === 1 || node.child(1).type.name === 'hardBreak')) from = offset
      } else if (to === doc.content.size && (node.type.name === 'blockquote' || (node.type.name === 'paragraph' && /^-{5,}/.test(node.textContent)))) {
        // Hlavička citácie („V pondelok … napísal:“) patrí k citácii, nie k podpisu.
        const p = prev as { node: PmNode; offset: number } | null
        to = node.type.name === 'blockquote' && p && p.offset > from && p.node.type.name === 'paragraph' && p.node.textContent.trim() ? p.offset : offset
      }
      prev = { node, offset }
    })
    return from === null ? null : { from, to: Math.max(from, to) }
  }

  /** Podpis ako HTML (bez riadku „--“), alebo null, ak v správe nie je. */
  export function signatureHTML(): string | null {
    if (!editor) return null
    const r = signatureRange()
    if (!r) return null
    const slice = editor.state.doc.slice(r.from, r.to).content
    // Prvý odsek je „--“ (prípadne „--<br>text“ zo starších podpisov).
    const html = getHTMLFromFragment(slice, editor.schema)
    return html.replace(/^<p[^>]*>--\s?(<br[^>]*>)?/, '<p>').replace(/^<p><\/p>/, '')
  }

  /** Vymení podpis v správe (null = odstráni). Bez podpisu sa nový vloží za vlastný text, pred citáciu. */
  export function setSignature(sigHtml: string | null): void {
    if (!editor) return
    const r = signatureRange()
    const content = sigHtml ? `<p>--</p>${sigHtml}` : ''
    if (r) {
      if (content) editor.chain().insertContentAt({ from: r.from, to: r.to }, content).run()
      else editor.chain().deleteRange({ from: r.from, to: r.to }).run()
    } else if (content) {
      editor.chain().insertContentAt(ownEnd(), content).run()
    }
  }

  /** Vlastný text správy ako HTML (bez podpisu a citácie) – pre uloženie šablóny. */
  export function ownHTML(): string {
    if (!editor) return ''
    return getHTMLFromFragment(editor.state.doc.slice(0, ownEnd()).content, editor.schema)
  }

  /** Šablóna: prázdny vlastný text nahradí, inak sa vloží na miesto kurzora (Ctrl+Z vráti späť). */
  export function insertTemplate(content: string): boolean {
    if (!editor) return false
    const end = ownEnd()
    if (!between(0, end).trim()) return editor.chain().focus().insertContentAt({ from: 0, to: end }, content).run()
    return editor.chain().focus().insertContent(content).run()
  }

  const active = (name: string, attrs?: Record<string, unknown>): boolean => {
    void tickCount
    return editor?.isActive(name, attrs) ?? false
  }

  /** Otvorená ponuka farieb: farba písma, zvýrazňovač alebo pozadie správy. */
  type ColorKind = 'textColor' | 'textBackground' | 'page'
  let colorOpen = $state<ColorKind | null>(null)
  /** Naposledy použitá farba (tlačidlo ju ukazuje ako Outlook). */
  let lastColor = $state<Record<ColorKind, string | null>>({ textColor: '#ff0000', textBackground: '#ffff00', page: null })
  let moreInput: HTMLInputElement | undefined = $state()
  let moreKind: ColorKind = 'textColor'
  const currentColor = (kind: ColorKind): string | null => {
    void tickCount
    if (kind === 'page') return pageBg
    return (editor?.getAttributes(kind)['color'] as string | undefined) ?? null
  }
  function setColor(kind: ColorKind, hex: string | null): void {
    colorOpen = null
    if (!editor) return
    if (hex) lastColor[kind] = hex
    if (kind === 'page') {
      pageBg = hex
      onchange(wrap(editor.getHTML()))
      editor.commands.focus()
      return
    }
    const chain = editor.chain().focus()
    ;(hex ? chain.setMark(kind, { color: hex }) : chain.unsetMark(kind)).run()
  }
  function moreColors(kind: ColorKind): void {
    moreKind = kind
    if (moreInput) {
      moreInput.value = currentColor(kind) ?? lastColor[kind] ?? '#000000'
      moreInput.click()
    }
  }

  const currentFont = (): string => {
    void tickCount
    return (editor?.getAttributes('fontFamily')['family'] as string | undefined) ?? ''
  }
  function setFont(f: string): void {
    if (!editor) return
    const chain = editor.chain().focus()
    ;(f ? chain.setMark('fontFamily', { family: f }) : chain.unsetMark('fontFamily')).run()
  }
  const currentSize = (): string => {
    void tickCount
    return (editor?.getAttributes('fontSize')['size'] as string | undefined) ?? ''
  }
  function setSize(v: string): void {
    if (!editor) return
    const chain = editor.chain().focus()
    ;(v ? chain.setMark('fontSize', { size: v }) : chain.unsetMark('fontSize')).run()
  }
  /** Zväčšiť / zmenšiť písmo o stupeň (bez veľkosti sa počíta s 11 pt ako v Outlooku). */
  function stepSize(dir: 1 | -1): void {
    const cur = currentSize()
    const m = /^([\d.]+)(pt|px)$/.exec(cur)
    const pt = m ? (m[2] === 'px' ? Number(m[1]) * 0.75 : Number(m[1])) : 11
    const next = dir > 0 ? SIZES.find((x) => x > pt + 0.01) : [...SIZES].reverse().find((x) => x < pt - 0.01)
    if (next !== undefined) setSize(`${next}pt`)
  }
  const currentAlign = (): string => {
    void tickCount
    return (editor?.getAttributes('paragraph')['textAlign'] as string | null) ?? (editor?.getAttributes('heading')['textAlign'] as string | null) ?? 'left'
  }
  function setAlign(a: 'left' | 'center' | 'right' | 'justify'): void {
    const v = a === 'left' ? null : a
    editor?.chain().focus().updateAttributes('paragraph', { textAlign: v }).updateAttributes('heading', { textAlign: v }).run()
  }
  /** Ponuka tabuľky: mriežka na výber veľkosti (ako v Outlooku) a úpravy, keď je kurzor v tabuľke. */
  let tableOpen = $state(false)
  let gridHover = $state<[number, number]>([0, 0])
  const inTable = (): boolean => {
    void tickCount
    return !!editor && isInTable(editor.state)
  }
  function insertTable(rows: number, cols: number): void {
    tableOpen = false
    const cell = { type: 'tableCell', content: [{ type: 'paragraph' }] }
    const row = { type: 'tableRow', content: Array.from({ length: cols }, () => cell) }
    if (!editor) return
    const from = editor.state.selection.from
    editor.chain().focus().insertContent([{ type: 'table', content: Array.from({ length: rows }, () => row) }, { type: 'paragraph' }]).run()
    // Kurzor do prvej bunky novej tabuľky (ako v Outlooku), nie za ňu.
    let at = -1
    editor.state.doc.descendants((n, pos) => {
      if (at < 0 && n.type.name === 'table' && pos >= from - 2) at = pos
      return at < 0
    })
    if (at >= 0) editor.commands.setTextSelection(at + 4)
  }
  function tableCmd(c: Command): void {
    tableOpen = false
    if (!editor) return
    editor.commands.focus()
    c(editor.state, editor.view.dispatch)
  }

  /** Zarážka: v zozname posunie položku o úroveň, inak odsadí odsek (po 40 px, najviac 8). */
  function indent(dir: 1 | -1): void {
    if (!editor) return
    if (editor.isActive('listItem')) {
      if (dir > 0) editor.chain().focus().sinkListItem('listItem').run()
      else editor.chain().focus().liftListItem('listItem').run()
      return
    }
    const cur = Number(editor.getAttributes('paragraph')['indent'] ?? 0) || Number(editor.getAttributes('heading')['indent'] ?? 0) || 0
    const n = Math.max(0, Math.min(8, cur + dir))
    editor.chain().focus().updateAttributes('paragraph', { indent: n }).updateAttributes('heading', { indent: n }).run()
  }

  type Cmd = () => void
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>): Cmd => () => {
    if (editor) fn(editor.chain().focus()).run()
  }

  async function openLink(): Promise<void> {
    if (!editor) return
    linkUrl = (editor.getAttributes('link')['href'] as string | undefined) ?? 'https://'
    linkOpen = true
    await tick()
    linkInput?.select()
  }

  function applyLink(e: SubmitEvent): void {
    e.preventDefault()
    if (!editor) return
    let url = linkUrl.trim()
    if (url && !/^(https?:|mailto:)/i.test(url)) url = url.includes('@') && !url.includes('/') ? `mailto:${url}` : `https://${url}`
    const chain = editor.chain().focus().extendMarkRange('link')
    if (!url || url === 'https://') chain.unsetLink().run()
    else if (editor.state.selection.empty && !editor.isActive('link')) chain.insertContent({ type: 'text', text: url.replace(/^mailto:/, ''), marks: [{ type: 'link', attrs: { href: url } }] }).run()
    else chain.setLink({ href: url }).run()
    linkOpen = false
  }

  function removeLink(): void {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run()
    linkOpen = false
  }

  function onToolbarKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const buttons = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }
</script>

<svelte:window
  onmousedown={(e) => {
    if ((colorOpen || tableOpen) && !(e.target as Element | null)?.closest?.('.dd')) {
      colorOpen = null
      tableOpen = false
    }
  }}
/>

{#snippet palette(kind: ColorKind, label: string)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="palette"
    class:hl={kind === 'textBackground'}
    role="group"
    aria-label={label}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        colorOpen = null
        editor?.commands.focus()
      }
    }}
  >
    {#if kind === 'textBackground'}
      {#each HIGHLIGHT as c (c)}
        <button type="button" class="swatch" class:on={currentColor(kind) === c} style:background={c} title={c.toUpperCase()} aria-label={c.toUpperCase()} onclick={() => setColor(kind, c)}></button>
      {/each}
      <button type="button" class="wide" onclick={() => setColor(kind, null)}>{t('editor.colorAuto')}</button>
    {:else}
      <button type="button" class="wide" onclick={() => setColor(kind, null)}>{kind === 'textColor' ? t('editor.colorAutomatic') : t('editor.colorAuto')}</button>
      <span class="caption">{t('editor.themeColors')}</span>
      {#each [THEME, ...SHADE_ROWS] as row, r (r)}
        {#each row as c, i (`${r}-${i}`)}
          <button type="button" class="swatch" class:first={r === 1} class:on={currentColor(kind) === c} style:background={c} title={c.toUpperCase()} aria-label={c.toUpperCase()} onclick={() => setColor(kind, c)}></button>
        {/each}
      {/each}
      <span class="caption">{t('editor.standardColors')}</span>
      {#each STANDARD as c (c)}
        <button type="button" class="swatch" class:on={currentColor(kind) === c} style:background={c} title={c.toUpperCase()} aria-label={c.toUpperCase()} onclick={() => setColor(kind, c)}></button>
      {/each}
      <button type="button" class="wide" onclick={() => moreColors(kind)}>{t('editor.moreColors')}</button>
    {/if}
  </div>
{/snippet}

<div class="rich">
  <div class="tools" role="toolbar" aria-label={t('editor.toolbar')} tabindex="-1" onkeydown={onToolbarKey}>
    <select class="font" aria-label={t('editor.font')} title={t('editor.font')} {disabled} value={currentFont()} onchange={(e) => setFont(e.currentTarget.value)}>
      <option value="">{t('editor.fontDefault')}</option>
      {#each EDITOR_FONTS as f (f)}<option value={f} style:font-family={`'${f}'`}>{f}</option>{/each}
    </select>
    <select class="size" aria-label={t('editor.fontSize')} title={t('editor.fontSize')} {disabled} value={currentSize()} onchange={(e) => setSize(e.currentTarget.value)}>
      <option value="">{t('editor.sizeDefault')}</option>
      {#if currentSize() && !SIZES.some((z) => `${z}pt` === currentSize())}<option value={currentSize()}>{currentSize()}</option>{/if}
      {#each SIZES as z (z)}<option value={`${z}pt`}>{String(z).replace('.', ',')}</option>{/each}
    </select>
    <button type="button" title={`${t('editor.grow')} (Ctrl+])`} aria-label={t('editor.grow')} {disabled} onclick={() => stepSize(1)}><span class="grow">A<sup>▲</sup></span></button>
    <button type="button" title={`${t('editor.shrink')} (Ctrl+[)`} aria-label={t('editor.shrink')} {disabled} onclick={() => stepSize(-1)}><span class="grow small">A<sup>▼</sup></span></button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" class:on={active('bold')} aria-pressed={active('bold')} title={`${t('editor.bold')} (Ctrl+B)`} aria-label={t('editor.bold')} {disabled} onclick={run((c) => c.toggleBold())}><b>B</b></button>
    <button type="button" class:on={active('italic')} aria-pressed={active('italic')} title={`${t('editor.italic')} (Ctrl+I)`} aria-label={t('editor.italic')} {disabled} onclick={run((c) => c.toggleItalic())}><i>I</i></button>
    <button type="button" class:on={active('underline')} aria-pressed={active('underline')} title={`${t('editor.underline')} (Ctrl+U)`} aria-label={t('editor.underline')} {disabled} onclick={run((c) => c.toggleUnderline())}><u>U</u></button>
    <button type="button" class:on={active('strike')} aria-pressed={active('strike')} title={t('editor.strike')} aria-label={t('editor.strike')} {disabled} onclick={run((c) => c.toggleStrike())}><s>S</s></button>
    {#each [{ kind: 'textBackground', label: t('editor.background') }, { kind: 'textColor', label: t('editor.color') }] as p (p.kind)}
      {@const kind = p.kind as ColorKind}
      <span class="dd">
        <button type="button" class="color-btn" title={p.label} aria-label={p.label} aria-haspopup="true" aria-expanded={colorOpen === kind} {disabled} onclick={() => (colorOpen = colorOpen === kind ? null : kind)}>
          {#if kind === 'textColor'}<span class="a">A</span>{:else}<span class="a hl">ab</span>{/if}
          <span class="bar" style:background={currentColor(kind) ?? lastColor[kind] ?? 'var(--text)'}></span>
        </button>
        {#if colorOpen === kind}{@render palette(kind, p.label)}{/if}
      </span>
    {/each}
    <span class="sep" aria-hidden="true"></span>
    <button type="button" class:on={active('bulletList')} aria-pressed={active('bulletList')} title={t('editor.bulletList')} aria-label={t('editor.bulletList')} {disabled} onclick={run((c) => c.toggleBulletList())}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="2.5" cy="4" r="1.3" /><circle cx="2.5" cy="8" r="1.3" /><circle cx="2.5" cy="12" r="1.3" /><path d="M6 4h9M6 8h9M6 12h9" /></svg>
    </button>
    <button type="button" class:on={active('orderedList')} aria-pressed={active('orderedList')} title={t('editor.orderedList')} aria-label={t('editor.orderedList')} {disabled} onclick={run((c) => c.toggleOrderedList())}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><text x="0.5" y="5.5" font-size="5">1</text><text x="0.5" y="9.5" font-size="5">2</text><text x="0.5" y="13.5" font-size="5">3</text><path d="M6 4h9M6 8h9M6 12h9" /></svg>
    </button>
    <button type="button" title={t('editor.indentLess')} aria-label={t('editor.indentLess')} {disabled} onclick={() => indent(-1)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 2.5h14M7 6h8M7 9.5h8M1 13h14M4.5 5.5 2 7.75 4.5 10" /></svg>
    </button>
    <button type="button" title={t('editor.indentMore')} aria-label={t('editor.indentMore')} {disabled} onclick={() => indent(1)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 2.5h14M7 6h8M7 9.5h8M1 13h14M2 5.5l2.5 2.25L2 10" /></svg>
    </button>
    <span class="sep" aria-hidden="true"></span>
    {#each [{ a: 'left', k: 'editor.alignLeft', d: 'M1 3h14M1 6.5h9M1 10h14M1 13.5h9' }, { a: 'center', k: 'editor.alignCenter', d: 'M1 3h14M3.5 6.5h9M1 10h14M3.5 13.5h9' }, { a: 'right', k: 'editor.alignRight', d: 'M1 3h14M6 6.5h9M1 10h14M6 13.5h9' }, { a: 'justify', k: 'editor.alignJustify', d: 'M1 3h14M1 6.5h14M1 10h14M1 13.5h14' }] as al (al.a)}
      <button type="button" class:on={currentAlign() === al.a} aria-pressed={currentAlign() === al.a} title={t(al.k as MessageKey)} aria-label={t(al.k as MessageKey)} {disabled} onclick={() => setAlign(al.a as 'left' | 'center' | 'right' | 'justify')}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d={al.d} /></svg>
      </button>
    {/each}
    <span class="sep" aria-hidden="true"></span>
    <button type="button" class:on={active('heading', { level: 2 })} aria-pressed={active('heading', { level: 2 })} title={t('editor.heading')} aria-label={t('editor.heading')} {disabled} onclick={run((c) => c.toggleHeading({ level: 2 }))}>H</button>
    <button type="button" class:on={active('blockquote')} aria-pressed={active('blockquote')} title={t('editor.quote')} aria-label={t('editor.quote')} {disabled} onclick={run((c) => c.toggleBlockquote())}>❝</button>
    <button type="button" class:on={active('link')} aria-pressed={active('link')} title={`${t('editor.link')} (Ctrl+K)`} aria-label={t('editor.link')} {disabled} onclick={openLink}>🔗</button>
    <span class="dd">
      <button type="button" class:on={inTable()} title={t('editor.table')} aria-label={t('editor.table')} aria-haspopup="true" aria-expanded={tableOpen} {disabled} onclick={() => ((tableOpen = !tableOpen), (colorOpen = null), (gridHover = [0, 0]))}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.5h13v11h-13zM1.5 6.2h13M1.5 9.8h13M5.8 2.5v11M10.2 2.5v11" /></svg>
      </button>
      {#if tableOpen}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="palette table-menu"
          role="group"
          aria-label={t('editor.table')}
          onkeydown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              tableOpen = false
              editor?.commands.focus()
            }
          }}
        >
          <span class="caption">{gridHover[0] ? `${gridHover[1]} × ${gridHover[0]}` : t('editor.tableInsert')}</span>
          <div class="grid" role="presentation" onmouseleave={() => (gridHover = [0, 0])}>
            {#each Array.from({ length: 8 }, (_, r) => r + 1) as r (r)}
              {#each Array.from({ length: 10 }, (_, c) => c + 1) as c (c)}
                <button
                  type="button"
                  class="cell"
                  class:hot={r <= gridHover[0] && c <= gridHover[1]}
                  aria-label={t('editor.tableSize', { cols: c, rows: r })}
                  onmouseenter={() => (gridHover = [r, c])}
                  onfocus={() => (gridHover = [r, c])}
                  onclick={() => insertTable(r, c)}
                ></button>
              {/each}
            {/each}
          </div>
          {#if inTable()}
            <button type="button" class="wide" onclick={() => tableCmd(addRowAfter)}>{t('editor.tableAddRow')}</button>
            <button type="button" class="wide" onclick={() => tableCmd(addColumnAfter)}>{t('editor.tableAddCol')}</button>
            <button type="button" class="wide" onclick={() => tableCmd(deleteRow)}>{t('editor.tableDelRow')}</button>
            <button type="button" class="wide" onclick={() => tableCmd(deleteColumn)}>{t('editor.tableDelCol')}</button>
            <button type="button" class="wide" onclick={() => tableCmd(deleteTable)}>{t('editor.tableDelete')}</button>
          {/if}
        </div>
      {/if}
    </span>
    {#if pageBackground}
      <span class="dd">
        <button type="button" class="color-btn" title={t('editor.pageBackground')} aria-label={t('editor.pageBackground')} aria-haspopup="true" aria-expanded={colorOpen === 'page'} {disabled} onclick={() => (colorOpen = colorOpen === 'page' ? null : 'page')}>
          <span class="page" style:background={pageBg ?? 'transparent'}></span>
        </button>
        {#if colorOpen === 'page'}{@render palette('page', t('editor.pageBackground'))}{/if}
      </span>
    {/if}
    <button type="button" title={t('editor.clear')} aria-label={t('editor.clear')} {disabled} onclick={run((c) => c.unsetAllMarks().clearNodes().updateAttributes('paragraph', { textAlign: null, indent: 0 }))}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h6M6.5 3 4 13M4 3h9M10 9l5 5M15 9l-5 5" /></svg>
    </button>
    <input class="visually-hidden" type="color" tabindex="-1" aria-label={t('editor.moreColors')} bind:this={moreInput} onchange={(e) => setColor(moreKind, e.currentTarget.value.toLowerCase())} />
  </div>
  {#if linkOpen}
    <form class="link-bar" onsubmit={applyLink}>
      <label>
        <span>{t('editor.linkUrl')}</span>
        <input
          bind:this={linkInput}
          bind:value={linkUrl}
          spellcheck="false"
          onkeydown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              linkOpen = false
              editor?.commands.focus()
            }
          }}
        />
      </label>
      <button class="btn small" type="submit">{t('editor.linkApply')}</button>
      <button class="btn small" type="button" onclick={removeLink}>{t('editor.linkRemove')}</button>
    </form>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="area"
    class:paged={pageBackground && !!pageBg}
    style:background={pageBackground && pageBg ? pageBg : undefined}
    bind:this={el}
    onkeydown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        void openLink()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === ']' || e.key === '[')) {
        e.preventDefault()
        stepSize(e.key === ']' ? 1 : -1)
      }
    }}
  ></div>
</div>

<style>
  .rich {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.1rem;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .tools button {
    min-width: 1.65rem;
    height: 1.75rem;
    padding: 0 0.15rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    cursor: pointer;
    font-size: 0.95rem;
  }
  .tools button:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .tools button.on {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .tools select {
    height: 1.75rem;
    padding: 0 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font-size: 0.82rem;
  }
  .tools select.font {
    width: 7.8rem;
  }
  .tools select.size {
    width: 3.8rem;
  }
  .grow {
    font-weight: 600;
  }
  .grow sup {
    font-size: 0.5rem;
  }
  .grow.small {
    font-size: 0.8rem;
  }
  .tools svg {
    width: 1rem;
    height: 1rem;
    fill: currentColor;
    stroke: currentColor;
    stroke-width: 1.3;
    vertical-align: middle;
  }
  .tools svg path {
    fill: none;
  }
  .tools svg text {
    stroke: none;
    font-family: var(--font-ui);
  }
  .dd {
    position: relative;
    display: inline-flex;
  }
  .tools .color-btn {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
  }
  .color-btn .a {
    font-weight: 600;
    line-height: 1;
  }
  .color-btn .a.hl {
    font-size: 0.8rem;
    font-style: italic;
  }
  .color-btn .page {
    width: 0.95rem;
    height: 0.95rem;
    border: 1.5px solid var(--text);
    border-radius: 2px;
  }
  /* S pozadím správy sa náhľad v editore ukáže ako u príjemcu: tmavý text na zvolenej farbe. */
  .area.paged {
    color: #1f2328;
  }
  .color-btn .bar {
    width: 1.05rem;
    height: 4px;
    border: 1px solid rgb(0 0 0 / 15%);
  }
  .palette {
    position: absolute;
    top: calc(100% + 4px);
    inset-inline-start: 0;
    z-index: 20;
    display: grid;
    grid-template-columns: repeat(10, 1.15rem);
    gap: 2px;
    padding: 0.45rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: 0 6px 20px rgb(0 0 0 / 18%);
  }
  .palette.hl {
    grid-template-columns: repeat(5, 1.4rem);
    gap: 4px;
  }
  .tools .palette .swatch {
    min-width: 0;
    width: 1.15rem;
    height: 1.15rem;
    border: 1px solid rgb(0 0 0 / 15%);
    border-radius: 0;
  }
  .palette.hl .swatch {
    width: 1.4rem;
    height: 1.4rem;
  }
  .tools .palette .swatch.first {
    margin-top: 4px;
  }
  .tools .palette .swatch:hover:not(:disabled) {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .tools .palette .swatch.on {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .palette .caption {
    grid-column: 1 / -1;
    margin-top: 0.3rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .palette.table-menu {
    grid-template-columns: 1fr;
    min-width: 12rem;
  }
  .table-menu .grid {
    display: grid;
    grid-template-columns: repeat(10, 1rem);
    gap: 2px;
  }
  .tools .table-menu .cell {
    min-width: 0;
    width: 1rem;
    height: 1rem;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 0;
    background: var(--bg);
  }
  .tools .table-menu .cell.hot {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .area :global(.doar-editor table) {
    border-collapse: collapse;
    margin: 0 0 0.6em;
  }
  .area :global(.doar-editor td) {
    min-width: 3em;
    padding: 4px 8px;
    border: 1px solid #9aa4b2;
    vertical-align: top;
  }
  .area :global(.doar-editor td p) {
    margin: 0;
  }
  .area :global(.doar-editor .selectedCell) {
    background: var(--accent-soft);
  }
  .tools .palette .wide {
    grid-column: 1 / -1;
    height: 1.7rem;
    font-size: 0.8rem;
    text-align: start;
    padding: 0 0.4rem;
    white-space: nowrap;
  }
  /* V tmavej téme by čierny text na tmavom pozadí nebolo vidieť – v editore sa ukáže svetlý (odošle sa čierny). */
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) .area :global(.doar-editor span[style*='rgb(0, 0, 0)']) {
      filter: invert(1);
    }
  }
  :global(:root[data-theme='dark']) .area :global(.doar-editor span[style*='rgb(0, 0, 0)']) {
    filter: invert(1);
  }
  .sep {
    align-self: stretch;
    width: 1px;
    margin: 0.3rem 0.2rem;
    background: var(--border);
  }
  .link-bar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.4rem 0.8rem;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
  }
  .link-bar label {
    flex: 1;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .link-bar input {
    flex: 1;
    padding: 0.3em 0.5em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
  }
  .btn.small {
    padding: 0.2em 0.6em;
    font-size: 0.82rem;
  }
  .area {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .area :global(.doar-editor) {
    min-height: 100%;
    padding: 1rem 1.1rem;
    font: 15px/1.55 var(--font-ui);
    outline: none;
    white-space: pre-wrap;
  }
  .area :global(.doar-editor p) {
    margin: 0 0 0.6em;
  }
  .area :global(.doar-editor blockquote) {
    margin: 0 0 0.6em;
    margin-inline-start: 0.3em;
    padding-inline-start: 0.9em;
    border-inline-start: 3px solid var(--border);
    color: var(--text-muted);
  }
  .area :global(.doar-editor a) {
    color: var(--accent);
  }
  .area :global(.doar-editor ul),
  .area :global(.doar-editor ol) {
    margin: 0 0 0.6em;
    padding-inline-start: 1.6em;
  }
  .area :global(.doar-editor li p) {
    margin: 0;
  }
  .area :global(.doar-editor h2) {
    font-size: 1.25rem;
    margin: 0.4em 0;
  }
</style>
