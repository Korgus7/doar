<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import { Editor, Extension } from '@tiptap/core'
  import StarterKit from '@tiptap/starter-kit'
  import { t } from '../i18n/index.svelte'
  import { textToHtml } from '../lib/compose-html'
  import type { Node as PmNode } from '@tiptap/pm/model'

  /**
   * Editor formátovaného textu (TipTap). Vie len to, čo sa bezpečne odošle e-mailom:
   * tučné, kurzíva, podčiarknutie, prečiarknutie, zoznamy, citácia, odkazy, nadpis.
   */
  let {
    html,
    disabled = false,
    onchange,
    label
  }: { html: string; disabled?: boolean; onchange: (html: string) => void; label: string } = $props()

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
            }
          }
        }
      ]
    }
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
        AutoDir
      ],
      content: html,
      editable: !disabled,

      editorProps: { attributes: { 'aria-label': label, 'aria-multiline': 'true', role: 'textbox', spellcheck: 'true', class: 'doar-editor' } },
      onUpdate: ({ editor: e }) => onchange(e.getHTML()),
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
    return editor?.getHTML() ?? html
  }

  export function setHTML(next: string): void {
    editor?.commands.setContent(next, { emitUpdate: true })
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

  const active = (name: string, attrs?: Record<string, unknown>): boolean => {
    void tickCount
    return editor?.isActive(name, attrs) ?? false
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

<div class="rich">
  <div class="tools" role="toolbar" aria-label={t('editor.toolbar')} tabindex="-1" onkeydown={onToolbarKey}>
    <button type="button" class:on={active('bold')} aria-pressed={active('bold')} title={`${t('editor.bold')} (Ctrl+B)`} aria-label={t('editor.bold')} {disabled} onclick={run((c) => c.toggleBold())}><b>B</b></button>
    <button type="button" class:on={active('italic')} aria-pressed={active('italic')} title={`${t('editor.italic')} (Ctrl+I)`} aria-label={t('editor.italic')} {disabled} onclick={run((c) => c.toggleItalic())}><i>I</i></button>
    <button type="button" class:on={active('underline')} aria-pressed={active('underline')} title={`${t('editor.underline')} (Ctrl+U)`} aria-label={t('editor.underline')} {disabled} onclick={run((c) => c.toggleUnderline())}><u>U</u></button>
    <button type="button" class:on={active('strike')} aria-pressed={active('strike')} title={t('editor.strike')} aria-label={t('editor.strike')} {disabled} onclick={run((c) => c.toggleStrike())}><s>S</s></button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" class:on={active('heading', { level: 2 })} aria-pressed={active('heading', { level: 2 })} title={t('editor.heading')} aria-label={t('editor.heading')} {disabled} onclick={run((c) => c.toggleHeading({ level: 2 }))}>H</button>
    <button type="button" class:on={active('bulletList')} aria-pressed={active('bulletList')} title={t('editor.bulletList')} aria-label={t('editor.bulletList')} {disabled} onclick={run((c) => c.toggleBulletList())}>•≡</button>
    <button type="button" class:on={active('orderedList')} aria-pressed={active('orderedList')} title={t('editor.orderedList')} aria-label={t('editor.orderedList')} {disabled} onclick={run((c) => c.toggleOrderedList())}>1≡</button>
    <button type="button" class:on={active('blockquote')} aria-pressed={active('blockquote')} title={t('editor.quote')} aria-label={t('editor.quote')} {disabled} onclick={run((c) => c.toggleBlockquote())}>❝</button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" class:on={active('link')} aria-pressed={active('link')} title={`${t('editor.link')} (Ctrl+K)`} aria-label={t('editor.link')} {disabled} onclick={openLink}>🔗</button>
    <button type="button" title={t('editor.clear')} aria-label={t('editor.clear')} {disabled} onclick={run((c) => c.unsetAllMarks().clearNodes())}>⌫</button>
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
    bind:this={el}
    onkeydown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        void openLink()
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
    gap: 0.15rem;
    padding: 0.3rem 0.8rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .tools button {
    min-width: 2rem;
    height: 2rem;
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
  .sep {
    width: 1px;
    margin: 0.3rem 0.3rem;
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
  .area :global(.doar-editor:focus-visible) {
    box-shadow: inset 0 0 0 2px var(--focus);
  }
</style>
