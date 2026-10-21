<script lang="ts">
  import type { MessageView } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { addressLine, fileSize, fullDate } from '../lib/format'
  import { mail, patchMessage, setFlags } from '../lib/mail.svelte'

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
img{max-width:100%;height:auto}table{max-width:100%}.doar-plain{white-space:pre-wrap}blockquote{margin:0 0 0 .4em;padding-left:.8em;border-left:3px solid #c9d1dc;color:#4a5361}a{color:#1d4ed8}`

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

  $effect(() => {
    // Udržať zoznam v súlade, ak sa správa pri otvorení stiahla.
    if (view && listItem && !listItem.downloaded) patchMessage(view.id, { downloaded: true })
  })
</script>

<section class="reader" aria-label={t('reader.label')}>
  {#if mail.selectedId === null}
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
        <h1>{view.subject || t('list.noSubject')}</h1>
        {#if listItem}
          <div class="actions">
            <button class="btn small" title="Ctrl+R" onclick={() => window.doar.openCompose('reply', view!.id)}>↩ {t('toolbar.reply')}</button>
            <button class="btn small" title="Ctrl+Shift+R" onclick={() => window.doar.openCompose('replyAll', view!.id)}>↩↩ {t('toolbar.replyAll')}</button>
            <button class="icon" title={listItem.flagged ? t('reader.unflag') : t('reader.flag')} aria-label={listItem.flagged ? t('reader.unflag') : t('reader.flag')} class:on={listItem.flagged} onclick={toggleFlag}>{listItem.flagged ? '★' : '☆'}</button>
            <button class="icon" title={listItem.seen ? t('reader.markUnread') : t('reader.markRead')} aria-label={listItem.seen ? t('reader.markUnread') : t('reader.markRead')} onclick={toggleSeen}>{listItem.seen ? '◉' : '○'}</button>
          </div>
        {/if}
      </div>
      <dl>
        <dt>{t('reader.from')}</dt>
        <dd class="from">{addressLine(view.from)}</dd>
        {#if view.to.length}<dt>{t('reader.to')}</dt><dd>{addressLine(view.to)}</dd>{/if}
        {#if view.cc.length}<dt>{t('reader.cc')}</dt><dd>{addressLine(view.cc)}</dd>{/if}
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
    </header>
    <iframe bind:this={frame} title={view.subject} sandbox="allow-same-origin" {srcdoc} onload={onFrameLoad}></iframe>
    {#if view.attachments.length}
      <footer>
        <strong>{t('reader.attachments', { n: view.attachments.length })}</strong>
        <ul>
          {#each view.attachments as a (a.index)}
            <li>📎 {a.filename} <span class="size">{fileSize(a.size)}</span></li>
          {/each}
        </ul>
        <small>{t('reader.attachmentsLater')}</small>
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
    gap: 0.5rem;
    align-items: flex-start;
  }
  h1 {
    flex: 1;
    margin: 0 0 0.6rem;
    font-size: 1.2rem;
    font-weight: 650;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .actions {
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
    gap: 0.3rem 1rem;
  }
  .size {
    color: var(--text-muted);
  }
  footer small {
    color: var(--text-muted);
  }
</style>
