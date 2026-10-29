<script lang="ts">
  import Icon from './Icon.svelte'
  import type { MessageView, ThreadMessage } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { addressLine, fileSize, fullDate, listDate } from '../lib/format'
  import { mail, patchMessage, setFlags, itemsById } from '../lib/mail.svelte'
  import { saveAllAttachments, attachmentMenu, openMenu, previewAttachment } from '../lib/actions.svelte'
  import { isArchiveId, isDangerousFile, isEmlId, previewKind } from '../../../shared/ipc'
  import { isDraft } from '../lib/actions.svelte'
  import { printDocument } from '../lib/print'
  import AiSummary from './AiSummary.svelte'
  import { ai, aiReady, aiUi } from '../lib/ai.svelte'
  import { remove, archive, allInArchive, allInTrash, openMoveDialog, singleAccount, toggleSpam, allInJunk, showToast, errorText, folderById, folderLabel } from '../lib/actions.svelte'
  import type { MenuEntry } from '../lib/actions.svelte'
  import { openSettings } from '../lib/settings.svelte'

  /** standalone = samostatné okno správy (bez zoznamu). */
  let { standalone = false }: { standalone?: boolean } = $props()

  let view = $state<MessageView | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let frame: HTMLIFrameElement | undefined = $state()
  let seq = 0
  /** Konverzácia otvorenej správy (zo všetkých priečinkov konta) – len ak má viac správ. */
  let thread = $state<ThreadMessage[]>([])
  let threadOpen = $state(true)
  let threadSeq = 0

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
      // Iná správa z konverzácie (nie riadok zoznamu).
      const inThread = thread.find((x) => x.id === id)
      if (inThread && !inThread.seen && item?.id !== id) {
        inThread.seen = true
        void setFlags([id], { seen: true })
      }
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
      thread = []
      return
    }
    void load(id)
    void loadThread(id)
  })

  async function loadThread(id: number): Promise<void> {
    const my = ++threadSeq
    if (isArchiveId(id)) {
      thread = []
      return
    }
    const list = await window.doar.invoke('messages.thread', { id }).catch(() => [])
    if (my === threadSeq) thread = list.length > 1 ? list : []
  }

  const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"
  const BASE_CSS = `html{color-scheme:light}body{margin:0;padding:16px 20px 32px;font:14px/1.55 'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,sans-serif;color:#1d2229;background:#fbfaf7;overflow-wrap:anywhere}
img{max-width:100%;height:auto}table{max-width:100%}.doar-plain{white-space:pre-wrap}blockquote{margin:0;margin-inline-start:.4em;padding-inline-start:.8em;border-inline-start:3px solid #d6d2ca;color:#4f555d}a{color:#2d4362}
:where(p,div,li,td,th,dd,dt,blockquote,pre,h1,h2,h3,h4,h5,h6,.doar-plain):not([dir]):not([dir] *){unicode-bidi:plaintext}`

  const srcdoc = $derived(
    view
      ? `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${BASE_CSS}</style></head><body>${view.html ?? ''}</body></html>`
      : ''
  )

  /** Odkazy v správe: nikdy nenavigovať v aplikácii; http/https/mailto otvoriť v systémovom prehliadači. */
  /**
   * Potiahnutie prílohy myšou von z Doaru (na plochu, do priečinka, do iného programu): jadro pripraví dočasnú
   * kópiu už pri stlačení tlačidla myši, systémové ťahanie súboru spustí hlavný proces.
   */
  const dragFiles = new Map<string, Promise<string | null>>()
  function prepareDrag(messageId: number, index: number): Promise<string | null> {
    const key = `${messageId}:${index}`
    let p = dragFiles.get(key)
    if (!p) {
      p = window.doar
        .invoke('attachments.prepareOpen', { messageId, index })
        .then((r) => r.path)
        .catch(() => null)
      dragFiles.set(key, p)
      // Dočasná kópia sa môže medzitým zmazať (upratovanie) – nepamätať si ju dlho.
      setTimeout(() => dragFiles.delete(key), 60_000)
    }
    return p
  }
  function onAttachmentDrag(e: DragEvent, messageId: number, index: number): void {
    e.preventDefault()
    void prepareDrag(messageId, index).then((path) => {
      if (path) window.doar.dragFile(path)
    })
  }

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

  /** Bezpečný názov súboru z predmetu správy. */
  function fileName(v: MessageView, ext: string): string {
    const base = (v.subject || t('list.noSubject')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'sprava'
    return `${base}.${ext}`
  }

  async function savePdf(v: MessageView): Promise<void> {
    try {
      if (await window.doar.savePdf(printDocument(v), v.subject || t('list.noSubject'))) showToast(t('reader.savedPdf'))
    } catch (e) {
      showToast(errorText(e), { tone: 'error' })
    }
  }

  async function saveEml(v: MessageView): Promise<void> {
    try {
      const path = await window.doar.chooseSavePath(fileName(v, 'eml'))
      if (!path) return
      await window.doar.invoke('messages.saveEml', { id: v.id, path })
      showToast(t('reader.savedEml', { name: path.split(/[\\/]/).pop() ?? '' }))
    } catch (e) {
      showToast(errorText(e), { tone: 'error' })
    }
  }

  /** Odhlásenie z odberu: jedným klikom (https POST), e-mailom (mailto), alebo stránka odosielateľa. */
  async function unsubscribe(v: MessageView): Promise<void> {
    if (!v.unsubscribe) return
    const sender = v.from[0]?.name || v.from[0]?.address || ''
    if (!confirm(t(`reader.unsubscribe.confirm.${v.unsubscribe}` as MessageKey, { sender }))) return
    try {
      const r = await window.doar.invoke('messages.unsubscribe', { id: v.id })
      if ('open' in r) {
        window.doar.openExternal(r.open)
        showToast(t('reader.unsubscribe.opened'))
      } else showToast(t(r.done === 'mailto' ? 'reader.unsubscribe.sentMail' : 'reader.unsubscribe.done'))
    } catch (e) {
      showToast(errorText(e), { tone: 'error' })
    }
  }

  function moreMenu(e: MouseEvent, v: MessageView): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const items: MenuEntry[] = []
    if (!standalone) items.push({ label: t('reader.openWindow'), shortcut: 'Enter', run: () => window.doar.openMessage(v.id) })
    items.push({ label: t('reader.savePdf'), run: () => void savePdf(v) })
    items.push({ label: t('reader.saveEml'), run: () => void saveEml(v) })
    if (v.unsubscribe && !isArchiveId(v.id)) items.push({ label: t('reader.unsubscribe.button'), run: () => void unsubscribe(v) })
    if (!standalone && !isArchiveId(v.id) && v.from[0]?.address) {
      const address = v.from[0].address
      items.push({ label: t('reader.createRule'), run: () => openSettings({ tab: 'rules', ruleDraft: { field: 'from', value: address, accountId: v.accountId, action: 'move' } }) })
    }
    openMenu(document.documentElement.dir === 'rtl' ? r.left : r.right - 220, r.bottom + 4, items, t('reader.more'))
  }

  // Ctrl+P z hlavného okna (MainShell) – vytlačí práve otvorenú správu.
  $effect(() => {
    const h = (): void => {
      if (view && mail.selection.length <= 1) window.doar.printHtml(printDocument(view), view.subject)
    }
    window.addEventListener('doar-print', h)
    return () => window.removeEventListener('doar-print', h)
  })

  // Samostatné okno: titulok okna = predmet správy.
  $effect(() => {
    if (standalone && view) document.title = `${view.subject || t('list.noSubject')} – Doar Mail`
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
        <button class="btn" disabled={allInArchive(ids)} onclick={() => archive(ids)}><Icon name="archive" />{t('actions.archive')}</button>
        <button class="btn" disabled={singleAccount(ids) === null} onclick={() => openMoveDialog(ids)}>{t('actions.moveTo')}</button>
        <button class="btn" onclick={() => toggleSpam(ids)}>{allInJunk(ids) ? t('actions.notSpam') : t('actions.spam')}</button>
        <button class="btn danger" onclick={() => remove(ids)}><Icon name="trash" />{allInTrash(ids) ? t('actions.deleteForever') : t('actions.delete')}</button>
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
        {#if listItem || (standalone && isArchiveId(view.id))}
          <div class="actions">
            {#if isDraft(view.id)}
              <button class="btn small btn-primary" title="Enter" onclick={() => window.doar.openCompose('draft', view!.id)}>✎ {t('reader.editDraft')}</button>
            {:else}
              <button class="btn small" title="Ctrl+R" onclick={() => window.doar.openCompose('reply', view!.id)}><Icon name="reply" size={15} />{t('toolbar.reply')}</button>
              <button class="btn small" title="Ctrl+Shift+R" onclick={() => window.doar.openCompose('replyAll', view!.id)}><Icon name="replyAll" size={15} />{t('toolbar.replyAll')}</button>
              <button class="btn small" title="Ctrl+F" onclick={() => window.doar.openCompose('forward', view!.id)}><Icon name="forward" size={15} />{t('toolbar.forward')}</button>
              {#if aiReady(ai.config)}
                <button class="btn small" class:on={aiUi.summaryFor === view.id} title={t('ai.summary.buttonTitle')} onclick={() => (aiUi.summaryFor = aiUi.summaryFor === view!.id ? null : view!.id)}><Icon name="ai" size={15} />{t('ai.summary.button')}</button>
              {/if}
            {/if}
            {#if isArchiveId(view.id)}
              <span class="readonly" title={isEmlId(view.id) ? t('reader.emlHint') : t('archive.readOnlyHint')}><Icon name="archive" size={14} /> {isEmlId(view.id) ? t('reader.emlFile') : t('archive.readOnly')}</span>
              <button class="icon" title={`${t('reader.print')} (Ctrl+P)`} aria-label={t('reader.print')} onclick={() => window.doar.printHtml(printDocument(view!), view!.subject)}><Icon name="print" size={17} /></button>
              <button class="icon" title={t('reader.more')} aria-label={t('reader.more')} aria-haspopup="menu" onclick={(e) => moreMenu(e, view!)}><Icon name="more" size={17} /></button>
            {:else if listItem}
              <button class="icon" title={listItem.flagged ? t('reader.unflag') : t('reader.flag')} aria-label={listItem.flagged ? t('reader.unflag') : t('reader.flag')} class:on={listItem.flagged} onclick={toggleFlag}><Icon name="star" size={17} filled={listItem.flagged} /></button>
              <button class="icon" title={listItem.seen ? t('reader.markUnread') : t('reader.markRead')} aria-label={listItem.seen ? t('reader.markUnread') : t('reader.markRead')} onclick={toggleSeen}><Icon name={listItem.seen ? 'unread' : 'read'} size={17} /></button>
              {#if !allInArchive([listItem.id])}
                <button class="icon" title={`${t('actions.archive')} (E)`} aria-label={t('actions.archive')} onclick={() => archive([listItem!.id])}><Icon name="archive" size={17} /></button>
              {/if}
              <button class="icon" title={`${t('reader.print')} (Ctrl+P)`} aria-label={t('reader.print')} onclick={() => window.doar.printHtml(printDocument(view!), view!.subject)}><Icon name="print" size={17} /></button>
              <button
                class="icon"
                title={`${allInTrash([listItem.id]) ? t('actions.deleteForever') : t('actions.delete')} (Del)`}
                aria-label={allInTrash([listItem.id]) ? t('actions.deleteForever') : t('actions.delete')}
                onclick={() => remove([listItem!.id])}><Icon name="trash" size={17} /></button
              >
              <button class="icon" title={t('reader.more')} aria-label={t('reader.more')} aria-haspopup="menu" onclick={(e) => moreMenu(e, view!)}><Icon name="more" size={17} /></button>
            {/if}
          </div>
        {/if}
      </div>
      <dl>
        <dt>{t('reader.from')}</dt>
        <dd class="from">
          <bdi>{addressLine(view.from)}</bdi>
          {#if view.unsubscribe && !isArchiveId(view.id)}
            {@const v = view}
            <button class="link unsub" onclick={() => void unsubscribe(v)}>{t('reader.unsubscribe.button')}</button>
          {/if}
        </dd>
        {#if view.to.length}<dt>{t('reader.to')}</dt><dd><bdi>{addressLine(view.to)}</bdi></dd>{/if}
        {#if view.cc.length}<dt>{t('reader.cc')}</dt><dd><bdi>{addressLine(view.cc)}</bdi></dd>{/if}
        <dt>{t('reader.date')}</dt>
        <dd>{fullDate(view.date)}</dd>
      </dl>
      {#if thread.length > 1}
        <section class="thread" aria-label={t('thread.label')}>
          <button class="thread-head" aria-expanded={threadOpen} onclick={() => (threadOpen = !threadOpen)}>
            <Icon name="chevron" size={13} />
            {t('thread.count', { n: thread.length })}
          </button>
          {#if threadOpen}
            <ol>
              {#each thread as m (m.id)}
                {@const f = folderById(m.folderId)}
                <li>
                  <button class="thread-item" class:current={m.id === view.id} class:unread={!m.seen} aria-current={m.id === view.id ? 'true' : undefined} onclick={() => void load(m.id)}>
                    <span class="t-from"><bdi>{m.fromName || m.fromAddr}</bdi></span>
                    {#if f && f.id !== listItem?.folderId}<span class="t-folder">{folderLabel(f)}</span>{/if}
                    {#if m.hasAttachments}<Icon name="attachment" size={12} />{/if}
                    <span class="t-snippet"><bdi>{m.snippet}</bdi></span>
                    <span class="t-date">{listDate(m.date)}</span>
                  </button>
                </li>
              {/each}
            </ol>
          {/if}
        </section>
      {/if}
      {#if view.remoteBlocked > 0 && !view.remoteShown}
        <div class="banner" role="note">
          <span>🛡 {t('reader.remoteBlocked')}</span>
          <span class="banner-actions">
            <button class="btn small" onclick={() => view && load(view.id, { showRemote: true })}>{t('reader.showImages')}</button>
            {#if sender}
              <button class="btn small" onclick={() => view && load(view.id, { showRemote: true, alwaysForSender: true })}>{t('reader.alwaysSender', { sender })}</button>
            {/if}
          </span>
        </div>
      {/if}
      {#if aiUi.summaryFor === view.id && aiReady(ai.config)}
        {#key view.id}<AiSummary messageId={view.id} />{/key}
      {/if}
    </header>
    {#if view.attachments.length}
      {@const v = view}
      <div class="atts" role="group" aria-label={t('reader.attachments', { n: v.attachments.length })}>
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
                draggable={isDangerousFile(a.filename) ? undefined : 'true'}
                onpointerdown={() => !isDangerousFile(a.filename) && prepareDrag(v.id, a.index)}
                ondragstart={(e) => onAttachmentDrag(e, v.id, a.index)}
                title={isDangerousFile(a.filename) ? t('attachments.openBlocked') : previewKind(a.filename, a.contentType) ? t('attachments.previewHint') : t('attachments.hint')}
                aria-haspopup={previewKind(a.filename, a.contentType) ? 'dialog' : 'menu'}
                onclick={(e) => {
                  // Obrázok, PDF a text: rovno náhľad; ostatné: ponuka Otvoriť / Uložiť ako.
                  if (!isDangerousFile(a.filename) && previewKind(a.filename, a.contentType)) return void previewAttachment(v.id, a)
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  openMenu(r.left, r.bottom + 4, attachmentMenu(v.id, a), a.filename)
                }}
                oncontextmenu={(e) => {
                  e.preventDefault()
                  openMenu(e.clientX, e.clientY, attachmentMenu(v.id, a), a.filename)
                }}
              >
                {#if isDangerousFile(a.filename)}<span aria-hidden="true">⛔</span>{:else}<Icon name="attachment" size={15} />{/if}
                <span class="att-name">{a.filename}</span>
                <span class="size">{fileSize(a.size)}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    <iframe bind:this={frame} title={view.subject} sandbox="allow-same-origin" {srcdoc} onload={onFrameLoad}></iframe>
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
    border-radius: var(--radius);
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
    font-size: 1.05rem;
    font-weight: 600;
    line-height: 1.35;
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
    color: #d4961a;
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
  .thread {
    margin-top: 0.6rem;
    font-size: 0.84rem;
  }
  .thread-head {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border: 0;
    background: none;
    padding: 0.1rem 0;
    color: var(--text-muted);
    cursor: pointer;
    font: inherit;
    font-weight: 600;
  }
  .thread-head[aria-expanded='false'] :global(svg) {
    transform: rotate(-90deg);
  }
  :global([dir='rtl']) .thread-head[aria-expanded='false'] :global(svg) {
    transform: rotate(90deg);
  }
  .thread ol {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
    max-height: 9.5rem;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .thread li + li {
    border-top: 1px solid var(--border);
  }
  .thread-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    border: 0;
    background: none;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    text-align: start;
    color: var(--text);
    font: inherit;
  }
  .thread-item:hover {
    background: var(--surface-2);
  }
  .thread-item.current {
    background: var(--accent-soft);
  }
  .thread-item.unread .t-from {
    font-weight: 650;
  }
  .t-from {
    flex: none;
    max-width: 11rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .t-folder {
    flex: none;
    font-size: 0.75rem;
    padding: 0 0.35rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
  }
  .t-snippet {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .t-date {
    flex: none;
    color: var(--text-muted);
    font-size: 0.78rem;
  }
  .unsub {
    margin-inline-start: 0.6rem;
    font-weight: 400;
    font-size: 0.82rem;
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
    background: #fbfaf7;
    min-height: 0;
  }
  /* Prílohy nad textom správy – hneď viditeľné; dajú sa potiahnuť myšou na plochu alebo do priečinka. */
  .atts {
    border-bottom: 1px solid var(--border);
    padding: 0.5rem 1.25rem;
    font-size: 0.85rem;
  }
  .atts ul {
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
