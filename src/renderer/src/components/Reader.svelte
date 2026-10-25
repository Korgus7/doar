<script lang="ts">
  import type { MessageView } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { addressLine, fileSize, fullDate } from '../lib/format'
  import { mail, patchMessage, setFlags, itemsById } from '../lib/mail.svelte'
  import { saveAllAttachments, attachmentMenu, openMenu } from '../lib/actions.svelte'
  import { isArchiveId, isDangerousFile } from '../../../shared/ipc'
  import { isDraft } from '../lib/actions.svelte'
  import { printDocument } from '../lib/print'
  import AiSummary from './AiSummary.svelte'
  import { ai, aiReady, aiUi } from '../lib/ai.svelte'
  import { remove, archive, allInArchive, allInTrash, openMoveDialog, singleAccount, toggleSpam, allInJunk } from '../lib/actions.svelte'

  let view = $state<MessageView | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let frame: HTMLIFrameElement | undefined = $state()
  let seq = 0

  const listItem = $derived.by(() => {
    for (const items of Object.values(mail.pages)) {
      const m = items.find((x) => x.id === mail.selectedId)
      if (m) return m
    }
    return null
  })

  async function load(id: number, opts: { showRemote?: boolean; alwaysForSender?: boolean } = {}): Promise<void> {
    const my = ++seq
    loading = true
    error = null
    try {
      const v = await window.doar.invoke('messages.get', { id, ...opts })
      if (my !== seq) return
      view = v
      // Otvorená správa = prečítaná (ako v Outlook Expresse s panelom na čítanie).
      const item = listItem
      if (item && item.id === id && !item.seen) void setFlags([id], { seen: true })
    } catch (e) {
      if (my !== seq) return
      view = null
      const code = (e as { code?: string }).code
      const key = `errors.${code}` as MessageKey
      error = t(key) !== key ? t(key) : t('errors.generic', { message: (e as { message?: string }).message ?? '' })
    } finally {
      if (my === seq) loading = false
    }
  }

  $effect(() => {
    const id = mail.selectedId
    if (id === null) {
      view = null
      error = null
      return
    }
    void load(id)
  })

  const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"
  const BASE_CSS = `html{color-scheme:light}body{margin:0;padding:16px 20px 32px;font:14px/1.55 'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,sans-serif;color:#1b1f24;background:#fff;overflow-wrap:anywhere}
img{max-width:100%;height:auto}table{max-width:100%}.doar-plain{white-space:pre-wrap}blockquote{margin:0;margin-inline-start:.4em;padding-inline-start:.8em;border-inline-start:3px solid #c9d1dc;color:#4a5361}a{color:#1d4ed8}
:where(p,div,li,td,th,dd,dt,blockquote,pre,h1,h2,h3,h4,h5,h6,.doar-plain):not([dir]):not([dir] *){unicode-bidi:plaintext}`

  const srcdoc = $derived(
    view
      ? `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${BASE_CSS}</style></head><body>${view.html ?? ''}</body></html>`
      : ''
  )

  /** Odkazy v správe: nikdy nenavigovať v aplikácii; http/https/mailto otvoriť v systémovom prehliadači. */
  function onFrameLoad(): void {
    const doc = frame?.contentDocument
    if (!doc) return
    doc.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (/^(https?:|mailto:)/i.test(href)) window.doar.openExternal(href)
    })
    doc.addEventListener('auxclick', (e) => e.preventDefault())
  }

  function toggleSeen(): void {
    if (!listItem) return
    void setFlags([listItem.id], { seen: !listItem.seen })
  }
  function toggleFlag(): void {
    if (!listItem) return
    void setFlags([listItem.id], { flagged: !listItem.flagged })
  }

  const sender = $derived(view?.from[0]?.address ?? '')

  // Ctrl+P z hlavného okna (MainShell) – vytlačí práve otvorenú správu.
  $effect(() => {
    const h = (): void => {
      if (view && mail.selection.length <= 1) window.doar.printHtml(printDocument(view), view.subject)
    }
    window.addEventListener('doar-print', h)
    return () => window.removeEventListener('doar-print', h)
  })

  $effect(() => {
    // Udržať zoznam v súlade, ak sa správa pri otvorení stiahla.
    if (view && listItem && !listItem.downloaded) patchMessage(view.id, { downloaded: true })
  })
</script>

<section class="reader" aria-label={t('reader.label')}>
  {#if mail.selection.length > 1}
    {@const ids = [...mail.selection]}
    {@const items = itemsById(ids)}
    <div class="multi">
      <p class="count">{t('reader.multi', { n: ids.length })}</p>
      <div class="multi-actions">
        <button class="btn" onclick={() => void setFlags(ids, { seen: items.some((m) => !m.seen) })}>
          {items.some((m) => !m.seen) ? t('reader.markRead') : t('reader.markUnread')}
        </button>
        <button class="btn" disabled={allInArchive(ids)} onclick={() => archive(ids)}>🗄 {t('actions.archive')}</button>
        <button class="btn" disabled={singleAccount(ids) === null} onclick={() => openMoveDialog(ids)}>{t('actions.moveTo')}</button>
        <button class="btn" onclick={() => toggleSpam(ids)}>{allInJunk(ids) ? t('actions.notSpam') : t('actions.spam')}</button>
        <button class="btn danger" onclick={() => remove(ids)}>🗑 {allInTrash(ids) ? t('actions.deleteForever') : t('actions.delete')}</button>
      </div>
    </div>
  {:else if mail.selectedId === null}
    <p class="empty">{t('reader.empty')}</p>
  {:else if error}
    <div class="empty">
      <p>{error}</p>
      <button class="btn" onclick={() => mail.selectedId !== null && load(mail.selectedId)}>{t('reader.retry')}</button>
    </div>
  {:else if !view}
    <p class="empty" aria-live="polite">{loading ? t('reader.loading') : ''}</p>
  {:else}
    <header>
      <div class="titlebar">
        <h1 dir="auto">{view.subject || t('list.noSubject')}</h1>
        {#if listItem}
          <div class="actions">
            {#if isDraft(view.id)}
              <button class="btn small btn-primary" title="Enter" onclick={() => window.doar.openCompose('draft', view!.id)}>✎ {t('reader.editDraft')}</button>
            {:else}
              <button class="btn small" title="Ctrl+R" onclick={() => window.doar.openCompose('reply', view!.id)}>↩ {t('toolbar.reply')}</button>
              <button class="btn small" title="Ctrl+Shift+R" onclick={() => window.doar.openCompose('replyAll', view!.id)}>↩↩ {t('toolbar.replyAll')}</button>
              <button class="btn small" title="Ctrl+F" onclick={() => window.doar.openCompose('forward', view!.id)}>↪ {t('toolbar.forward')}</button>
              {#if aiReady(ai.config)}
                <button class="btn small" class:on={aiUi.summaryFor === view.id} title={t('ai.summary.buttonTitle')} onclick={() => (aiUi.summaryFor = aiUi.summaryFor === view!.id ? null : view!.id)}>✨ {t('ai.summary.button')}</button>
              {/if}
            {/if}
            {#if isArchiveId(view.id)}
              <span class="readonly" title={t('archive.readOnlyHint')}>🗃 {t('archive.readOnly')}</span>
              <button class="icon" title={`${t('reader.print')} (Ctrl+P)`} aria-label={t('reader.print')} onclick={() => window.doar.printHtml(printDocument(view!), view!.subject)}>🖨</button>
            {:else}
              <button class="icon" title={listItem.flagged ? t('reader.unflag') : t('reader.flag')} aria-label={listItem.flagged ? t('reader.unflag') : t('reader.flag')} class:on={listItem.flagged} onclick={toggleFlag}>{listItem.flagged ? '★' : '☆'}</button>
              <button class="icon" title={listItem.seen ? t('reader.markUnread') : t('reader.markRead')} aria-label={listItem.seen ? t('reader.markUnread') : t('reader.markRead')} onclick={toggleSeen}>{listItem.seen ? '◉' : '○'}</button>
              {#if !allInArchive([listItem.id])}
                <button class="icon" title={`${t('actions.archive')} (E)`} aria-label={t('actions.archive')} onclick={() => archive([listItem!.id])}>🗄</button>
              {/if}
              <button class="icon" title={`${t('reader.print')} (Ctrl+P)`} aria-label={t('reader.print')} onclick={() => window.doar.printHtml(printDocument(view!), view!.subject)}>🖨</button>
              <button
                class="icon"
                title={`${allInTrash([listItem.id]) ? t('actions.deleteForever') : t('actions.delete')} (Del)`}
                aria-label={allInTrash([listItem.id]) ? t('actions.deleteForever') : t('actions.delete')}
                onclick={() => remove([listItem!.id])}>🗑</button
              >
            {/if}
          </div>
        {/if}
      </div>
      <dl>
        <dt>{t('reader.from')}</dt>
        <dd class="from"><bdi>{addressLine(view.from)}</bdi></dd>
        {#if view.to.length}<dt>{t('reader.to')}</dt><dd><bdi>{addressLine(view.to)}</bdi></dd>{/if}
        {#if view.cc.length}<dt>{t('reader.cc')}</dt><dd><bdi>{addressLine(view.cc)}</bdi></dd>{/if}
        <dt>{t('reader.date')}</dt>
        <dd>{fullDate(view.date)}</dd>
      </dl>
      {#if view.remoteBlocked > 0 && !view.remoteShown}
        <div class="banner" role="note">
          <span>🛡 {t('reader.remoteBlocked')}</span>
          <span class="banner-actions">
            <button class="btn small" onclick={() => mail.selectedId !== null && load(mail.selectedId, { showRemote: true })}>{t('reader.showImages')}</button>
            {#if sender}
              <button class="btn small" onclick={() => mail.selectedId !== null && load(mail.selectedId, { showRemote: true, alwaysForSender: true })}>{t('reader.alwaysSender', { sender })}</button>
            {/if}
          </span>
        </div>
      {/if}
      {#if aiUi.summaryFor === view.id && aiReady(ai.config)}
        {#key view.id}<AiSummary messageId={view.id} />{/key}
      {/if}
    </header>
    <iframe bind:this={frame} title={view.subject} sandbox="allow-same-origin" {srcdoc} onload={onFrameLoad}></iframe>
    {#if view.attachments.length}
      {@const v = view}
      <footer>
        <div class="att-head">
          <strong>{t('reader.attachments', { n: v.attachments.length })}</strong>
          {#if v.attachments.length > 1}
            <button class="link" onclick={() => void saveAllAttachments(v.id)}>{t('attachments.saveAll')}</button>
          {/if}
        </div>
        <ul>
          {#each v.attachments as a (a.index)}
            <li>
              <button
                class="att"
                class:blocked={isDangerousFile(a.filename)}
                title={isDangerousFile(a.filename) ? t('attachments.openBlocked') : t('attachments.hint')}
                aria-haspopup="menu"
                onclick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  openMenu(r.left, r.bottom + 4, attachmentMenu(v.id, a), a.filename)
                }}
                oncontextmenu={(e) => {
                  e.preventDefault()
                  openMenu(e.clientX, e.clientY, attachmentMenu(v.id, a), a.filename)
                }}
              >
                <span aria-hidden="true">{isDangerousFile(a.filename) ? '⛔' : '📎'}</span>
                <span class="att-name">{a.filename}</span>
                <span class="size">{fileSize(a.size)}</span>
              </button>
            </li>
          {/each}
        </ul>
      </footer>
    {/if}
  {/if}
</section>

<style>
  .reader {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    min-width: 0;
  }
  .multi {
    margin: auto;
    padding: 2rem;
    text-align: center;
  }
  .count {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0 0 1rem;
  }
  .multi-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: center;
  }
  .btn.danger {
    color: var(--danger);
  }
  .readonly {
    align-self: center;
    font-size: 0.8rem;
    color: var(--text-muted);
    padding: 0.1rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
  }
  .empty {
    margin: auto;
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
  }
  header {
    padding: 1rem 1.25rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .titlebar {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    align-items: flex-start;
  }
  h1 {
    /* Pri úzkom paneli sa tlačidlá presunú pod nadpis, nadpis sa nesmie zúžiť na pár písmen. */
    flex: 1 1 14rem;
    margin: 0 0 0.6rem;
    font-size: 1.2rem;
    font-weight: 650;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .actions {
    margin-bottom: 0.5rem;
    display: flex;
    gap: 0.3rem;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .icon {
    border: 1px solid transparent;
    background: none;
    border-radius: var(--radius-sm);
    width: 2rem;
    height: 2rem;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1.05rem;
  }
  .icon:hover {
    background: var(--surface-2);
  }
  .icon.on {
    color: #e8a400;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.75rem;
    margin: 0;
    font-size: 0.88rem;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .from {
    font-weight: 600;
  }
  .banner {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.7rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    font-size: 0.85rem;
  }
  .banner-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .btn.small {
    padding: 0.2em 0.6em;
    font-size: 0.82rem;
  }
  iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: #fff;
    min-height: 0;
  }
  footer {
    border-top: 1px solid var(--border);
    padding: 0.6rem 1.25rem;
    font-size: 0.85rem;
  }
  footer ul {
    list-style: none;
    padding: 0;
    margin: 0.3rem 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.5rem;
  }
  .size {
    color: var(--text-muted);
  }
  .att-head {
    display: flex;
    gap: 1rem;
    align-items: baseline;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.85rem;
  }
  .link:hover {
    text-decoration: underline;
  }
  .att {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    max-width: 22rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    cursor: pointer;
    color: var(--text);
  }
  .att:hover {
    border-color: var(--accent);
  }
  .att-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
