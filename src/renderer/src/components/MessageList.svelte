<script lang="ts">
  import { t } from '../i18n/index.svelte'
  import { listDate } from '../lib/format'
  import { mail, messageAt, loadPage, PAGE, setFlags, setSelection, indexOf, allIds, itemsById, findFolder } from '../lib/mail.svelte'
  import { isArchiveId } from '../../../shared/ipc'
  import { ui, messageMenu, openMenu, remove, removeForever, archive, openMoveDialog, selectAll, isDraft, folderLabel, folderById } from '../lib/actions.svelte'
  import { runSearch } from '../lib/mail.svelte'

  const ROW = 74
  const OVERSCAN = 8

  let el: HTMLDivElement | undefined = $state()
  let scrollTop = $state(0)
  let height = $state(600)
  /** Kotva pre Shift + klik / Shift + šípky. */
  let anchor: number | null = null

  const currentFolder = $derived(findFolder(mail.folderId) ?? null)
  const showRecipients = $derived(!mail.search && (currentFolder?.specialUse === 'sent' || currentFolder?.specialUse === 'drafts'))
  const searching = $derived(mail.search !== null)
  const unified = $derived(searching ? mail.accounts.length > 1 : mail.folderId === null)
  const selected = $derived(new Set(mail.selection))

  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN))
  const end = $derived(Math.min(mail.total, Math.ceil((scrollTop + height) / ROW) + OVERSCAN))
  const indexes = $derived(Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i))

  // Načítať stránky, ktoré sú práve vidieť.
  $effect(() => {
    void mail.listVersion
    for (let p = Math.floor(start / PAGE); p <= Math.floor(Math.max(start, end - 1) / PAGE); p++) void loadPage(p)
  })

  // Nový priečinok alebo hľadanie → na začiatok zoznamu.
  $effect(() => {
    void mail.folderId
    void mail.search
    anchor = null
    if (el) el.scrollTop = 0
  })

  function scrollTo(i: number): void {
    if (!el || i < 0) return
    const top = i * ROW
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight
  }

  /** Rozsah od kotvy po index (aj cez nenačítané stránky). */
  async function selectRange(to: number): Promise<void> {
    const from = anchor ?? to
    const [a, b] = from <= to ? [from, to] : [to, from]
    let ids: number[] = []
    for (let i = a; i <= b; i++) {
      const m = messageAt(i)
      if (!m) {
        ids = (await allIds()).slice(a, b + 1)
        break
      }
      ids.push(m.id)
    }
    setSelection(ids, messageAt(to)?.id ?? null)
  }

  /** Pohyb kurzora klávesnicou. */
  function go(i: number, extend: boolean): void {
    i = Math.max(0, Math.min(mail.total - 1, i))
    const m = messageAt(i)
    if (!m) return
    if (extend) void selectRange(i)
    else {
      anchor = i
      setSelection([m.id])
    }
    scrollTo(i)
  }

  function onRowClick(e: MouseEvent, i: number, id: number): void {
    if (e.shiftKey) {
      void selectRange(i)
    } else if (e.ctrlKey || e.metaKey) {
      anchor = i
      setSelection(selected.has(id) ? mail.selection.filter((x) => x !== id) : [...mail.selection, id], id)
    } else {
      anchor = i
      setSelection([id])
    }
  }

  function onContext(e: MouseEvent, i: number, id: number): void {
    e.preventDefault()
    if (!selected.has(id)) {
      anchor = i
      setSelection([id])
    }
    const ids = [...mail.selection]
    openMenu(e.clientX, e.clientY, messageMenu(ids), t('actions.menu'))
  }

  /** Kontextová ponuka z klávesnice (Shift+F10 / kláves ponuky) – pri riadku s kurzorom. */
  function keyboardMenu(): void {
    if (!mail.selection.length) return
    const i = indexOf(mail.cursor)
    const row = el?.querySelector(`#msg-${mail.cursor}`)?.getBoundingClientRect()
    const box = el?.getBoundingClientRect()
    const x = (row?.left ?? box?.left ?? 0) + 24
    const y = row ? row.top + row.height / 2 : (box?.top ?? 0) + Math.max(0, i) * ROW
    openMenu(x, y, messageMenu([...mail.selection]), t('actions.menu'))
  }

  function onKey(e: KeyboardEvent): void {
    const i = indexOf(mail.cursor)
    const ctrl = e.ctrlKey || e.metaKey
    const step = Math.max(1, Math.floor(height / ROW) - 1)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      go(i + 1, e.shiftKey)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      go(i < 0 ? 0 : i - 1, e.shiftKey)
    } else if (e.key === 'Home') {
      e.preventDefault()
      go(0, e.shiftKey)
    } else if (e.key === 'End') {
      e.preventDefault()
      go(mail.total - 1, e.shiftKey)
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      go(i + (e.key === 'PageDown' ? step : -step), e.shiftKey)
    } else if (e.key === 'Enter' && mail.selectedId !== null && isDraft(mail.selectedId)) {
      e.preventDefault()
      window.doar.openCompose('draft', mail.selectedId)
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      void selectAll()
    } else if (e.key === 'Delete') {
      e.preventDefault()
      if (e.shiftKey) void removeForever([...mail.selection])
      else remove([...mail.selection])
    } else if (!ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault()
      archive([...mail.selection])
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      if (mail.selection.length) openMoveDialog([...mail.selection])
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      keyboardMenu()
    }
  }

  function toggleFlag(e: MouseEvent, id: number, flagged: boolean): void {
    e.stopPropagation()
    void setFlags([id], { flagged: !flagged })
  }

  function onDragStart(e: DragEvent, i: number, id: number): void {
    // Správy archívu sa nedajú presúvať.
    if (isArchiveId(id)) {
      e.preventDefault()
      return
    }
    if (!selected.has(id)) {
      anchor = i
      setSelection([id])
    }
    const ids = [...mail.selection]
    const accountIds = [...new Set(itemsById(ids).map((m) => m.accountId))]
    ui.dragging = { ids, accountIds }
    if (!e.dataTransfer) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-doar-messages', JSON.stringify(ids))
    // Štítok pri kurzore: koľko správ sa presúva.
    const ghost = document.createElement('div')
    ghost.className = 'doar-drag-ghost'
    ghost.textContent = ids.length === 1 ? (messageAt(i)?.subject || t('list.noSubject')) : t('reader.multi', { n: ids.length })
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, -12, -8)
    setTimeout(() => ghost.remove(), 0)
  }
</script>

<div class="wrap">
{#if mail.search}
  <div class="search-bar" role="status">
    <span>{mail.total ? t('search.results', { n: mail.total }) : t('search.none')}</span>
    <button class="link" onclick={() => void runSearch('')}>{t('search.clear')}</button>
    {#if mail.searchNotDownloaded > 0}
      <p class="incomplete">⚠ {t('search.incomplete', { n: mail.searchNotDownloaded })}</p>
    {/if}
  </div>
{/if}
<div
  class="list"
  bind:this={el}
  bind:clientHeight={height}
  onscroll={() => (scrollTop = el?.scrollTop ?? 0)}
  role="listbox"
  tabindex="0"
  aria-label={t('list.label')}
  aria-multiselectable="true"
  aria-activedescendant={mail.cursor ? `msg-${mail.cursor}` : undefined}
  onkeydown={onKey}
>
  {#if mail.total === 0}
    <p class="empty">{mail.search ? t('search.none') : t('list.empty')}</p>
  {:else}
    <div class="spacer" style:height={`${mail.total * ROW}px`}>
      {#each indexes as i (i)}
        {@const m = messageAt(i)}
        <div class="row-wrap" style:top={`${i * ROW}px`}>
          {#if m}
            <div
              id={`msg-${m.id}`}
              class="row"
              class:unread={!m.seen}
              class:selected={selected.has(m.id)}
              class:cursor={mail.cursor === m.id && mail.selection.length > 1}
              role="option"
              aria-selected={selected.has(m.id)}
              tabindex="-1"
              draggable="true"
              onclick={(e) => onRowClick(e, i, m.id)}
              oncontextmenu={(e) => onContext(e, i, m.id)}
              ondblclick={() => isDraft(m.id) && window.doar.openCompose('draft', m.id)}
              ondragstart={(e) => onDragStart(e, i, m.id)}
              ondragend={() => (ui.dragging = null)}
              onkeydown={() => {}}
            >
              {#if unified}<span class="acc" style:background={m.accountColor} aria-hidden="true"></span>{/if}
              <div class="line1">
                <span class="mark" title={m.seen ? undefined : t('list.unread')}>{m.seen ? '' : '•'}</span>
                <span class="from">
                  {#if showRecipients}
                    {m.to.join(', ') || t('list.unknownSender')}
                  {:else}
                    {m.fromName || m.fromAddr || t('list.unknownSender')}
                  {/if}
                </span>
                {#if m.localState === 'pending'}<span class="state" title={t('list.pending')}>⏳</span>{/if}
                {#if !m.downloaded}<span class="state cloud" title={t('list.notDownloaded')} aria-label={t('list.notDownloaded')}>☁</span>{/if}
                {#if m.localState === 'failed'}<span class="state warn" title={t('list.failed')}>⚠</span>{/if}
                <span class="date">{listDate(m.date)}</span>
              </div>
              <div class="line2">
                <span class="subject">{m.subject || t('list.noSubject')}</span>
                {#if m.hasAttachments}<span class="clip" title={t('list.attachment')}>📎</span>{/if}
                {#if isArchiveId(m.id)}
                  {#if m.flagged}<span class="star on" aria-label={t('reader.flagged')}>★</span>{/if}
                {:else}
                  <button
                    class="star"
                    class:on={m.flagged}
                    title={m.flagged ? t('reader.unflag') : t('reader.flag')}
                    aria-label={m.flagged ? t('reader.unflag') : t('reader.flag')}
                    tabindex="-1"
                    onclick={(e) => toggleFlag(e, m.id, m.flagged)}>{m.flagged ? '★' : '☆'}</button
                  >
                {/if}
              </div>
              <div class="line3">
                {#if searching}{@const f = folderById(m.folderId)}<span class="accname">{f ? folderLabel(f) : ''}{unified ? ` (${m.accountName})` : ''} · </span>{:else if unified}<span class="accname">{m.accountName} · </span>{/if}{m.snippet}
              </div>
            </div>
          {:else}
            <div class="row placeholder" aria-hidden="true"></div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
</div>

<style>
  .wrap {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface);
  }
  .search-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem 0.8rem;
    padding: 0.45rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
    font-size: 0.85rem;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.85rem;
  }
  .incomplete {
    flex-basis: 100%;
    margin: 0;
    color: var(--warning);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    background: var(--surface);
    outline-offset: -2px;
  }
  .empty {
    padding: 2rem 1rem;
    color: var(--text-muted);
    text-align: center;
  }
  .spacer {
    position: relative;
  }
  .row-wrap {
    position: absolute;
    left: 0;
    right: 0;
    height: 74px;
  }
  .row {
    position: relative;
    height: 100%;
    padding: 0.45rem 0.8rem 0.4rem 1rem;
    border-bottom: 1px solid var(--border);
    cursor: default;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.05rem;
    overflow: hidden;
  }
  .row:hover {
    background: color-mix(in srgb, var(--text) 4%, transparent);
  }
  .row.selected {
    background: var(--accent-soft);
  }
  .row.cursor {
    outline: 1px dotted var(--accent);
    outline-offset: -2px;
  }
  :global(.doar-drag-ghost) {
    position: fixed;
    top: -100px;
    left: -100px;
    max-width: 280px;
    padding: 0.3rem 0.7rem;
    border-radius: 6px;
    background: var(--accent);
    color: var(--accent-text);
    font: 600 0.85rem var(--font-ui);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .placeholder {
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--text) 4%, transparent), transparent);
  }
  .acc {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
  }
  .line1,
  .line2 {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    min-width: 0;
  }
  .mark {
    flex: 0 0 0.5rem;
    color: var(--accent);
    font-weight: 700;
    margin-left: -0.6rem;
  }
  .from,
  .subject {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unread .from,
  .unread .subject {
    font-weight: 650;
  }
  .date {
    flex: none;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .unread .date {
    color: var(--accent);
    font-weight: 600;
  }
  .line2 {
    font-size: 0.92rem;
  }
  .line3 {
    font-size: 0.82rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .accname {
    font-weight: 600;
  }
  .state {
    font-size: 0.75rem;
  }
  .state.cloud {
    color: var(--text-muted);
    opacity: 0.7;
  }
  .state.warn {
    color: var(--warning);
  }
  .clip {
    font-size: 0.8rem;
  }
  .star {
    flex: none;
    border: 0;
    background: none;
    padding: 0 0.1rem;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    opacity: 0.45;
  }
  .row:hover .star,
  .star.on {
    opacity: 1;
  }
  .star.on {
    color: #e8a400;
  }
</style>
