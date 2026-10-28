<script lang="ts">
  import type { AddressSuggestion } from '../../../shared/ipc'
  import { t } from '../i18n/index.svelte'

  /**
   * Pole s adresami (Komu, Kópia, Skrytá kópia) s našepkávaním. Adresy sa oddeľujú čiarkou;
   * návrhy sa hľadajú pre práve písanú adresu (za poslednou čiarkou).
   */
  let {
    value = $bindable(''),
    id,
    label,
    placeholder = '',
    disabled = false,
    inputEl = $bindable()
  }: { value?: string; id: string; label: string; placeholder?: string; disabled?: boolean; inputEl?: HTMLInputElement } = $props()

  let items = $state<AddressSuggestion[]>([])
  let active = $state(-1)
  let open = $state(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  /** Práve písaná časť (za poslednou čiarkou alebo bodkočiarkou). */
  function currentToken(): { start: number; text: string } {
    const caret = inputEl?.selectionStart ?? value.length
    const before = value.slice(0, caret)
    const start = Math.max(before.lastIndexOf(','), before.lastIndexOf(';')) + 1
    return { start, text: value.slice(start, caret).trim() }
  }

  function onInput(): void {
    if (timer) clearTimeout(timer)
    const tok = currentToken()
    if (tok.text.length < 1 || /<.*>/.test(tok.text)) {
      close()
      return
    }
    timer = setTimeout(async () => {
      const my = ++seq
      const r = await window.doar.invoke('addresses.suggest', { query: tok.text, limit: 8 }).catch(() => [])
      if (my !== seq) return
      // Adresy, ktoré už v poli sú, neponúkať.
      const present = new Set(value.toLowerCase().match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? [])
      items = r.filter((a) => (a.group ? a.group.members.some((m) => !present.has(m.address.toLowerCase())) : !present.has(a.address.toLowerCase())))
      active = items.length ? 0 : -1
      open = items.length > 0
    }, 120)
  }

  function close(): void {
    open = false
    items = []
    active = -1
  }

  function choose(a: AddressSuggestion): void {
    const caret = inputEl?.selectionStart ?? value.length
    const { start } = currentToken()
    const after = value.slice(caret).replace(/^[^,;]*/, '')
    const one = (x: { name: string; address: string }): string => {
      const name = x.name.replace(/[",<>]/g, '').trim()
      return name ? `${name} <${x.address}>` : x.address
    }
    // Skupina: všetky jej adresy, ktoré v poli ešte nie sú.
    const present = new Set(value.slice(0, start).toLowerCase().match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? [])
    const entry = a.group ? a.group.members.filter((m) => !present.has(m.address.toLowerCase())).map(one).join(', ') : one(a)
    const head = value.slice(0, start).replace(/\s*$/, '')
    value = `${head ? `${head} ` : ''}${entry}, ${after.replace(/^[,;]\s*/, '')}`.replace(/\s+$/, ' ')
    close()
    queueMicrotask(() => {
      const pos = (head ? head.length + 1 : 0) + entry.length + 2
      inputEl?.setSelectionRange(pos, pos)
      inputEl?.focus()
    })
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      active = (active + d + items.length) % items.length
    } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0 && items[active]) {
      e.preventDefault()
      e.stopPropagation()
      choose(items[active]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }
</script>

<div class="wrap">
  <input
    dir="auto"
    bind:this={inputEl}
    bind:value
    {id}
    type="text"
    autocomplete="off"
    spellcheck="false"
    {placeholder}
    {disabled}
    aria-label={label}
    role="combobox"
    aria-autocomplete="list"
    aria-expanded={open}
    aria-controls={`${id}-list`}
    aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
    oninput={onInput}
    onkeydown={onKey}
    onblur={() => setTimeout(close, 150)}
  />
  {#if open}
    <ul class="list" id={`${id}-list`} role="listbox" aria-label={t('compose.suggestions')}>
      {#each items as a, i (a.group ? `g${a.group.id}` : a.address)}
        <li
          id={`${id}-opt-${i}`}
          role="option"
          aria-selected={i === active}
          class:active={i === active}
          onmousedown={(e) => {
            e.preventDefault()
            choose(a)
          }}
        >
          {#if a.group}
            <strong>{a.name}</strong>
            <span>{t('contacts.groupMembers', { n: a.group.members.length })}</span>
          {:else}
            {#if a.name}<strong>{a.name}</strong>{/if}
            <span>{a.address}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    min-width: 0;
  }
  input {
    width: 100%;
    padding: 0.4em 0.55em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
  }
  .list {
    position: absolute;
    z-index: 20;
    left: 0;
    right: 0;
    top: calc(100% + 2px);
    list-style: none;
    margin: 0;
    padding: 0.25rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
    max-height: 16rem;
    overflow: auto;
  }
  li {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    padding: 0.35rem 0.6rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  li.active {
    background: var(--accent-soft);
  }
  li span {
    color: var(--text-muted);
    font-size: 0.88rem;
  }
</style>
