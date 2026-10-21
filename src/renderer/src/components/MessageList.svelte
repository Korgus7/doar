<script lang="ts">
  import { t } from '../i18n/index.svelte'
  import { listDate } from '../lib/format'
  import { mail, messageAt, loadPage, PAGE, setFlags } from '../lib/mail.svelte'

  const ROW = 74
  const OVERSCAN = 8

  let el: HTMLDivElement | undefined = $state()
  let scrollTop = $state(0)
  let height = $state(600)

  const currentFolder = $derived(mail.folderId === null ? null : mail.folders.find((f) => f.id === mail.folderId))
  const showRecipients = $derived(currentFolder?.specialUse === 'sent' || currentFolder?.specialUse === 'drafts')
  const unified = $derived(mail.folderId === null)

  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN))
  const end = $derived(Math.min(mail.total, Math.ceil((scrollTop + height) / ROW) + OVERSCAN))
  const indexes = $derived(Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i))

  // Načítať stránky, ktoré sú práve vidieť.
  $effect(() => {
    void mail.listVersion
    for (let p = Math.floor(start / PAGE); p <= Math.floor(Math.max(start, end - 1) / PAGE); p++) void loadPage(p)
  })

  // Nový priečinok → na začiatok zoznamu.
  $effect(() => {
    void mail.folderId
    if (el) el.scrollTop = 0
  })

  function selectedIndex(): number {
    for (let i = 0; i < mail.total; i++) if (messageAt(i)?.id === mail.selectedId) return i
    return -1
  }

  function select(i: number): void {
    const m = messageAt(i)
    if (!m) return
    mail.selectedId = m.id
    if (!el) return
    const top = i * ROW
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight
  }

  function onKey(e: KeyboardEvent): void {
    const i = selectedIndex()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      select(Math.min(mail.total - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      select(Math.max(0, i < 0 ? 0 : i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      select(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      select(mail.total - 1)
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      const step = Math.max(1, Math.floor(height / ROW) - 1)
      select(Math.max(0, Math.min(mail.total - 1, i + (e.key === 'PageDown' ? step : -step))))
    }
  }

  function toggleFlag(e: MouseEvent, id: number, flagged: boolean): void {
    e.stopPropagation()
    void setFlags([id], { flagged: !flagged })
  }
</script>

<div
  class="list"
  bind:this={el}
  bind:clientHeight={height}
  onscroll={() => (scrollTop = el?.scrollTop ?? 0)}
  role="listbox"
  tabindex="0"
  aria-label={t('list.label')}
  aria-activedescendant={mail.selectedId ? `msg-${mail.selectedId}` : undefined}
  onkeydown={onKey}
>
  {#if mail.total === 0}
    <p class="empty">{t('list.empty')}</p>
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
              class:selected={mail.selectedId === m.id}
              role="option"
              aria-selected={mail.selectedId === m.id}
              tabindex="-1"
              onclick={() => (mail.selectedId = m.id)}
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
                {#if m.localState === 'failed'}<span class="state warn" title={t('list.failed')}>⚠</span>{/if}
                <span class="date">{listDate(m.date)}</span>
              </div>
              <div class="line2">
                <span class="subject">{m.subject || t('list.noSubject')}</span>
                {#if m.hasAttachments}<span class="clip" title={t('list.attachment')}>📎</span>{/if}
                <button
                  class="star"
                  class:on={m.flagged}
                  title={m.flagged ? t('reader.unflag') : t('reader.flag')}
                  aria-label={m.flagged ? t('reader.unflag') : t('reader.flag')}
                  tabindex="-1"
                  onclick={(e) => toggleFlag(e, m.id, m.flagged)}>{m.flagged ? '★' : '☆'}</button
                >
              </div>
              <div class="line3">
                {#if unified}<span class="accname">{m.accountName} · </span>{/if}{m.snippet}
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

<style>
  .list {
    height: 100%;
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
