<script lang="ts">
  import { onMount } from 'svelte'
  import { t } from '../i18n/index.svelte'
  import { mail } from '../lib/mail.svelte'
  import FolderPane from './FolderPane.svelte'
  import MessageList from './MessageList.svelte'
  import Reader from './Reader.svelte'
  import OutboxBanner from './OutboxBanner.svelte'

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

  function syncNow(): void {
    void window.doar.invoke('sync.now', {})
  }

  function onGlobalKey(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey || e.metaKey
    if (e.key === 'F5') {
      e.preventDefault()
      syncNow()
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      window.doar.openCompose('new')
    } else if (ctrl && e.key.toLowerCase() === 'r' && mail.selectedId !== null) {
      e.preventDefault()
      window.doar.openCompose(e.shiftKey ? 'replyAll' : 'reply', mail.selectedId)
    }
  }
</script>

<svelte:window onkeydown={onGlobalKey} />

<div class="shell">
  <div class="toolbar">
    <button class="btn btn-primary" onclick={() => window.doar.openCompose('new')} title="Ctrl+N">✉ {t('toolbar.newMessage')}</button>
    <button class="btn" onclick={syncNow} disabled={syncing} title="F5">
      <span class:spin={syncing} aria-hidden="true">⟳</span>
      {t('toolbar.sync')}
    </button>
  </div>
  <OutboxBanner />
  <div class="panes" style:grid-template-columns={`${widths.folders}px 5px ${widths.list}px 5px minmax(0, 1fr)`}>
    <FolderPane {onAddAccount} />
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

<style>
  .shell {
    display: grid;
    grid-template-rows: auto auto 1fr;
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
