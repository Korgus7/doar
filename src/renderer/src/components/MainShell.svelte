<script lang="ts">
  import { onMount } from 'svelte'
  import { t } from '../i18n/index.svelte'
  import { mail, findFolder, setThreads } from '../lib/mail.svelte'
  import { isArchiveId } from '../../../shared/ipc'
  import FolderPane from './FolderPane.svelte'
  import MessageList from './MessageList.svelte'
  import Reader from './Reader.svelte'
  import OutboxBanner from './OutboxBanner.svelte'
  import UpdateBanner from './UpdateBanner.svelte'
  import ContextMenu from './ContextMenu.svelte'
  import MoveDialog from './MoveDialog.svelte'
  import NewFolderDialog from './NewFolderDialog.svelte'
  import Toast from './Toast.svelte'
  import AttachmentPreview from './AttachmentPreview.svelte'
  import { ui, undoLast, folderLabel } from '../lib/actions.svelte'
  import { runSearch } from '../lib/mail.svelte'
  import { openSettings } from '../lib/settings.svelte'
  import Icon from './Icon.svelte'
  import { openMenu } from '../lib/actions.svelte'
  import { backup } from '../lib/backup.svelte'
  import { restore } from '../lib/restore.svelte'
  import { openArchive, openDroppedFiles } from '../lib/archive.svelte'
  import AdvancedSearch from './AdvancedSearch.svelte'
  import { checkUpdates } from '../lib/update.svelte'

  let { onAddAccount }: { onAddAccount: () => void } = $props()

  const KEY = 'doar.panes'
  let widths = $state({ folders: 240, list: 400 })
  let syncing = $derived(Object.values(mail.statuses).some((s) => s.state === 'syncing'))

  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { folders?: number; list?: number } | null
      if (saved?.folders) widths.folders = saved.folders
      if (saved?.list) widths.list = saved.list
    } catch {
      /* predvolené šírky */
    }
  })

  function save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(widths))
    } catch {
      /* nezapamätá sa */
    }
  }

  const LIMITS = { folders: [160, 420], list: [260, 760] } as const
  function clamp(which: 'folders' | 'list', v: number): number {
    const [min, max] = LIMITS[which]
    return Math.max(min, Math.min(max, Math.round(v)))
  }

  function startDrag(which: 'folders' | 'list', e: PointerEvent): void {
    const startX = e.clientX
    const startW = widths[which]
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      widths[which] = clamp(which, startW + ev.clientX - startX)
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      save()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  function keyResize(which: 'folders' | 'list', e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    widths[which] = clamp(which, widths[which] + (e.key === 'ArrowRight' ? 20 : -20))
    save()
  }

  // Vyhľadávanie: spustí sa chvíľu po dopísaní (alebo hneď Enterom).
  let query = $state('')
  let searchEl: HTMLInputElement | undefined = $state()
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  const currentFolder = $derived(findFolder(mail.folderId) ?? null)

  // Prepnutie priečinka hľadanie zruší – vyprázdniť aj pole.
  $effect(() => {
    if (!mail.search) query = ''
  })

  function onSearchInput(): void {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void runSearch(query), 300)
  }

  function onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (searchTimer) clearTimeout(searchTimer)
      void runSearch(query)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (searchTimer) clearTimeout(searchTimer)
      query = ''
      void runSearch('', 'all', null)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      document.querySelector<HTMLElement>('[role="listbox"]')?.focus()
    }
  }

  /** Ponuka ☰: veci, ktoré boli dole v paneli priečinkov, plus nastavenia a pomocník. */
  function appMenu(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const rtl = document.documentElement.dir === 'rtl'
    openMenu(rtl ? r.left : r.right - 240, r.bottom + 4, [
      { label: t('menu.addAccount'), run: onAddAccount },
      {
        label: t('menu.backup'),
        run: () => {
          backup.accountId = mail.folderId === null ? null : (findFolder(mail.folderId)?.accountId ?? null)
          backup.open = true
        }
      },
      { label: t('menu.restore'), run: () => ((restore.kind = 'restore'), (restore.open = true)) },
      { label: t('menu.importOther'), run: () => ((restore.kind = 'import'), (restore.open = true)) },
      { label: t('menu.openArchive'), run: () => void openArchive() },
      { label: t('menu.openEml'), run: () => void openArchive() },
      'sep',
      { label: `${mail.threads ? '✓ ' : ''}${t('menu.threads')}`, run: () => void setThreads(!mail.threads) },
      'sep',
      { label: t('menu.settings'), shortcut: 'Ctrl+,', run: () => openSettings() },
      { label: t('menu.checkUpdates'), run: checkUpdates },
      { label: t('menu.about'), run: () => window.doar.showAbout() }
    ], t('toolbar.menu'))
  }

  function syncNow(): void {
    void window.doar.invoke('sync.now', {})
  }

  function editable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null
    return !!el?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')
  }

  function onGlobalKey(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault()
      searchEl?.focus()
      searchEl?.select()
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z' && ui.toast?.undo && !editable(e.target)) {
      e.preventDefault()
      void undoLast()
    } else if (e.key === 'F5') {
      e.preventDefault()
      syncNow()
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      window.doar.openCompose('new')
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault()
      window.dispatchEvent(new Event('doar-print'))
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'f' && mail.selectedId !== null && !editable(e.target)) {
      e.preventDefault()
      window.doar.openCompose('forward', mail.selectedId)
    } else if (ctrl && e.key.toLowerCase() === 'r' && mail.selectedId !== null) {
      e.preventDefault()
      window.doar.openCompose(e.shiftKey ? 'replyAll' : 'reply', mail.selectedId)
    }
  }
</script>

<svelte:window
  onkeydown={onGlobalKey}
  ondragover={(e) => {
    // Súbory z Prieskumníka (.eml, mbox) – nie správy ani priečinky ťahané v aplikácii.
    if (!ui.dragging && !ui.draggingFolder && e.dataTransfer?.types.includes('Files')) e.preventDefault()
  }}
  ondrop={(e) => {
    if (ui.dragging || ui.draggingFolder || !e.dataTransfer?.files.length) return
    e.preventDefault()
    void openDroppedFiles([...e.dataTransfer.files])
  }}
/>

<div class="shell">
  <div class="toolbar">
    <button class="btn btn-primary" onclick={() => window.doar.openCompose('new')} title="Ctrl+N"><Icon name="compose" />{t('toolbar.newMessage')}</button>
    <button class="btn" onclick={() => (ui.contacts = true)}><Icon name="contacts" />{t('toolbar.contacts')}</button>
    <button class="btn" onclick={syncNow} disabled={syncing} title="F5">
      <span class="sync-ico" class:spin={syncing}><Icon name="sync" /></span>
      {t('toolbar.sync')}
    </button>
    <div class="search" role="search">
      <span class="field">
        <span class="glass"><Icon name="search" /></span>
        <input
          bind:this={searchEl}
          bind:value={query}
          type="search"
          placeholder={t('toolbar.search')}
          aria-label={t('search.label')}
          title={t('search.tip')}
          spellcheck="false"
          oninput={onSearchInput}
          onkeydown={onSearchKey}
        />
        <AdvancedSearch {query} />
      </span>
      {#if mail.search}
        <select
          aria-label={t('search.scope')}
          value={mail.search.scope}
          onchange={(e) => void runSearch(query, (e.currentTarget as HTMLSelectElement).value as 'all' | 'folder')}
        >
          <option value="all">{isArchiveId(mail.folderId) ? t('search.scopeArchive') : t('search.scopeAll')}</option>
          <option value="folder" disabled={!currentFolder}>{t('search.scopeFolder', { folder: currentFolder ? folderLabel(currentFolder) : '' })}</option>
        </select>
      {/if}
    </div>
    <button class="btn icon-btn" onclick={() => openSettings()} title={`${t('toolbar.settings')} (Ctrl+,)`} aria-label={t('toolbar.settings')}><Icon name="settings" size={17} /></button>
    <button class="btn icon-btn" onclick={appMenu} title={t('toolbar.menu')} aria-label={t('toolbar.menu')} aria-haspopup="menu"><Icon name="menu" size={17} /></button>
  </div>
  <UpdateBanner />
  <OutboxBanner />
  <div class="panes" style:grid-template-columns={`${widths.folders}px 5px ${widths.list}px 5px minmax(0, 1fr)`}>
    <FolderPane />
    <!-- Posúvateľný oddeľovač je podľa ARIA interaktívny prvok (ovládanie šípkami). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="sep"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={160}
      aria-valuemax={420}
      aria-valuenow={widths.folders}
      tabindex="0"
      onpointerdown={(e) => startDrag('folders', e)}
      onkeydown={(e) => keyResize('folders', e)}
    ></div>
    <MessageList />
    <!-- Posúvateľný oddeľovač je podľa ARIA interaktívny prvok (ovládanie šípkami). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="sep"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={260}
      aria-valuemax={760}
      aria-valuenow={widths.list}
      tabindex="0"
      onpointerdown={(e) => startDrag('list', e)}
      onkeydown={(e) => keyResize('list', e)}
    ></div>
    <Reader />
  </div>
</div>
<ContextMenu />
<MoveDialog />
<NewFolderDialog />
<Toast />
<AttachmentPreview />

<style>
  .shell {
    display: grid;
    grid-template-rows: auto auto auto 1fr;
    height: 100%;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .toolbar .btn {
    padding: 0.35em 0.8em;
  }
  .icon-btn {
    padding-inline: 0.55em !important;
    color: var(--text-muted);
  }
  .icon-btn:hover {
    color: var(--text);
  }
  .sync-ico {
    display: inline-flex;
  }
  .search {
    flex: 1;
    max-width: 34rem;
    margin-inline: auto 0.25rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    position: relative;
  }
  .field {
    flex: 1;
    min-width: 8rem;
    display: flex;
    align-items: center;
    position: relative;
  }
  .glass {
    position: absolute;
    inset-inline-start: 0.6rem;
    display: inline-flex;
    color: var(--text-muted);
    pointer-events: none;
  }
  .search input {
    flex: 1;
    min-width: 8rem;
    padding-block: 0.38em;
    padding-inline: 1.9rem 2.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
  }
  .search select {
    padding: 0.36em 0.5em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    max-width: 14rem;
  }
  .toolbar .btn:disabled {
    opacity: 0.7;
  }
  .spin {
    display: inline-block;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
  .panes {
    /* Vždy tretí riadok – aj keď pruh odosielania (2. riadok) nie je zobrazený. */
    grid-row: 4;
    display: grid;
    min-height: 0;
    height: 100%;
  }
  .panes > :global(*) {
    min-height: 0;
  }
  .sep {
    cursor: col-resize;
    background: var(--border);
    background-clip: content-box;
    padding: 0 2px;
  }
  .sep:hover,
  .sep:focus-visible {
    background-color: var(--accent);
  }
</style>
