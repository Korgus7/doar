<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { Contact, ContactInput, ContactSyncStatus, MailAddressItem } from '../../../shared/ipc'
  import { t } from '../i18n/index.svelte'
  import { ui, errorText, openMenu } from '../lib/actions.svelte'
  import Icon from './Icon.svelte'
  import { listDate } from '../lib/format'
  import { oauthSignIn } from '../lib/oauth.svelte'

  let dialogEl: HTMLDivElement | undefined = $state()
  let tab = $state<'saved' | 'mail'>('saved')
  let query = $state('')
  let contacts = $state<Contact[]>([])
  let fromMail = $state<MailAddressItem[]>([])
  let total = $state(0)
  let selectedId = $state<number | null>(null)
  let selectedMail = $state<string | null>(null)
  /** Formulár: upravovaný kontakt (id), alebo nový (bez id); null = nič nevybrané. */
  let form = $state<ContactInput | null>(null)
  let busy = $state(false)
  let message = $state<{ text: string; tone: 'ok' | 'error' } | null>(null)
  let syncState = $state<ContactSyncStatus | null>(null)
  let syncAccount = $state<number | null>(null)

  const empty = (): ContactInput => ({ name: '', email: '', phone: '', company: '', note: '', address: '' })
  const mailItem = $derived(fromMail.find((m) => m.email === selectedMail) ?? null)

  async function load(): Promise<void> {
    const [list, all, mail, st] = await Promise.all([
      window.doar.invoke('contacts.list', { query }),
      query ? window.doar.invoke('contacts.list', {}) : null,
      window.doar.invoke('contacts.fromMail', { query }),
      window.doar.invoke('contacts.syncStatus').catch(() => null)
    ])
    syncState = st
    if (st && (syncAccount === null || !st.candidates.some((c) => c.accountId === syncAccount))) syncAccount = st.candidates[0]?.accountId ?? null
    contacts = list
    total = (all ?? list).length
    fromMail = mail
  }

  // Len pri otvorení adresára (stav vo vnútri sa nesmie stať závislosťou – inak by hľadanie všetko vynulovalo).
  $effect(() => {
    if (!ui.contacts) return
    untrack(() => {
      tab = 'saved'
      query = ''
      form = null
      selectedId = null
      selectedMail = null
      message = null
      void load().then(() => tick()).then(() => dialogEl?.querySelector<HTMLInputElement>('input[type="search"]')?.focus())
    })
  })

  // Zmeny z synchronizácie (aj na pozadí) sa hneď ukážu.
  $effect(() => {
    if (!ui.contacts) return
    return window.doar.on('contacts.changed', () => void load())
  })

  /** Synchronizácia s kontaktmi Google: spustiť; pri chýbajúcom oprávnení sa raz opýta Google. */
  async function runSync(askPermission = true): Promise<void> {
    busy = true
    message = null
    try {
      const r = await window.doar.invoke('contacts.syncNow')
      message = {
        text: t('contacts.sync.done', { downloaded: r.downloaded, uploaded: r.uploaded, removed: r.removed }) + (r.onServer !== null ? ` ${t('contacts.sync.serverInfo', { n: r.onServer, m: r.withoutEmail })}` : ''),
        tone: 'ok'
      }
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'CONTACTS_PERMISSION' && askPermission) {
        busy = false
        await grant()
        return
      }
      message = { text: errorText(err), tone: 'error' }
    } finally {
      busy = false
      await load()
    }
  }

  async function grant(): Promise<void> {
    const st = syncState?.enabled
    if (!st || busy) return
    busy = true
    message = null
    try {
      const r = await oauthSignIn('google', st.email, undefined, { contacts: true })
      await window.doar.invoke('accounts.reauth', { id: st.accountId, flowId: r.flowId })
    } catch (err) {
      message = { text: errorText(err), tone: 'error' }
      busy = false
      return
    }
    busy = false
    await runSync(false)
  }

  async function enableSync(): Promise<void> {
    const acc = syncState?.candidates.find((c) => c.accountId === syncAccount)
    if (!acc || busy) return
    if (!confirm(t('contacts.sync.confirm', { email: acc.email, n: syncState?.localOnly ?? 0 }))) return
    try {
      await window.doar.invoke('contacts.syncEnable', { accountId: acc.accountId })
    } catch (err) {
      message = { text: errorText(err), tone: 'error' }
      return
    }
    await load()
    await runSync()
  }

  async function disableSync(): Promise<void> {
    const st = syncState?.enabled
    if (!st || busy) return
    if (!confirm(t('contacts.sync.offConfirm', { email: st.email }))) return
    await window.doar.invoke('contacts.syncDisable').catch(() => {})
    message = null
    await load()
  }

  let searchTimer: ReturnType<typeof setTimeout> | null = null
  function onSearch(): void {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void load(), 150)
  }

  function close(): void {
    ui.contacts = false
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !ui.menu) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  function pick(c: Contact): void {
    selectedId = c.id
    form = { id: c.id, name: c.name, email: c.email, phone: c.phone, company: c.company, note: c.note, address: c.address }
    message = null
  }

  async function newContact(): Promise<void> {
    tab = 'saved'
    selectedId = null
    form = empty()
    message = null
    await tick()
    dialogEl?.querySelector<HTMLInputElement>('.editor input')?.focus()
  }

  async function save(e: SubmitEvent): Promise<void> {
    e.preventDefault()
    if (!form || busy) return
    busy = true
    message = null
    try {
      const c = await window.doar.invoke('contacts.save', $state.snapshot(form))
      await load()
      selectedId = c.id
      form = { ...c }
      message = { text: t('contacts.saved'), tone: 'ok' }
    } catch (err) {
      message = { text: errorText(err), tone: 'error' }
    } finally {
      busy = false
    }
  }

  async function remove(): Promise<void> {
    if (!form?.id || busy) return
    const ok = confirm(t('contacts.deleteConfirm', { name: form.name || form.email || form.phone }))
    // Po systémovom okne potvrdenia vrátiť fokus do adresára (Escape, Tab).
    dialogEl?.focus()
    if (!ok) return
    busy = true
    try {
      await window.doar.invoke('contacts.delete', { ids: [form.id] })
      form = null
      selectedId = null
      await load()
      message = { text: t('contacts.deleted'), tone: 'ok' }
    } catch (err) {
      message = { text: errorText(err), tone: 'error' }
    } finally {
      busy = false
    }
  }

  function write(name: string, email: string): void {
    const n = name.replace(/["\\]/g, '').trim()
    window.doar.openCompose('new', undefined, n ? `${/[,;<>@()]/.test(n) ? `"${n}"` : n} <${email}>` : email)
  }

  /** Meno, firma a adresa na obálku alebo do listu. */
  function copyAddress(): void {
    if (!form) return
    const text = [form.name, form.company, form.address].map((x) => x.trim()).filter(Boolean).join('\n')
    window.doar.copyText(text)
    message = { text: t('contacts.copied'), tone: 'ok' }
  }

  async function addFromMail(emails: string[]): Promise<void> {
    if (!emails.length || busy) return
    busy = true
    try {
      const r = await window.doar.invoke('contacts.addFromMail', { emails })
      selectedMail = null
      await load()
      message = { text: t('contacts.added', { n: r.added }), tone: 'ok' }
    } catch (err) {
      message = { text: errorText(err), tone: 'error' }
    } finally {
      busy = false
    }
  }

  async function importFiles(): Promise<void> {
    const paths = await window.doar.chooseContactsFiles()
    if (!paths.length) return
    busy = true
    message = null
    try {
      const r = await window.doar.invoke('contacts.import', { paths })
      tab = 'saved'
      await load()
      message = { text: t('contacts.imported', r), tone: 'ok' }
    } catch (err) {
      message = { text: errorText(err), tone: 'error' }
    } finally {
      busy = false
    }
  }

  async function exportAs(ext: 'vcf' | 'csv'): Promise<void> {
    const path = await window.doar.chooseSavePath(`${t('contacts.title')}.${ext}`)
    if (!path) return
    busy = true
    message = null
    try {
      const r = await window.doar.invoke('contacts.export', { path })
      message = { text: t('contacts.exported', { n: r.count }), tone: 'ok' }
    } catch (err) {
      message = { text: errorText(err), tone: 'error' }
    } finally {
      busy = false
    }
  }

  function exportMenu(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    openMenu(r.left, r.bottom + 2, [
      { label: t('contacts.exportVcf'), run: () => void exportAs('vcf') },
      { label: t('contacts.exportCsv'), run: () => void exportAs('csv') }
    ], t('contacts.export'))
  }

  function tabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    tab = tab === 'saved' ? 'mail' : 'saved'
    void tick().then(() => dialogEl?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus())
  }
</script>

<svelte:window
  onkeydown={(e) => {
    // Escape aj keď fokus nie je v okne (napr. po systémovom potvrdení).
    if (ui.contacts && e.key === 'Escape' && !ui.menu && !dialogEl?.contains(e.target as Node)) {
      e.preventDefault()
      close()
    }
  }}
/>

{#if ui.contacts}
  <div class="overlay" role="presentation">
    <div class="dialog" bind:this={dialogEl} role="dialog" aria-modal="true" aria-labelledby="ct-title" tabindex="-1" onkeydown={onKey}>
      <header>
        <h1 id="ct-title">{t('contacts.title')}</h1>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'saved'} tabindex={tab === 'saved' ? 0 : -1} onclick={() => (tab = 'saved')} onkeydown={tabKey}>{t('contacts.tabSaved')} <span class="count">{total}</span></button>
          <button role="tab" aria-selected={tab === 'mail'} tabindex={tab === 'mail' ? 0 : -1} onclick={() => (tab = 'mail')} onkeydown={tabKey}>{t('contacts.tabMail')} <span class="count">{fromMail.length}</span></button>
        </div>
        <button class="x" aria-label={t('settings.close')} title={t('settings.close')} onclick={close}>×</button>
      </header>

      <div class="actions-bar">
        <input type="search" bind:value={query} oninput={onSearch} placeholder={t('contacts.search')} aria-label={t('contacts.search')} spellcheck="false" />
        <span class="spacer"></span>
        <button class="btn btn-primary" onclick={newContact} disabled={busy}><Icon name="plus" />{t('contacts.new')}</button>
        <button class="btn" onclick={importFiles} disabled={busy}>{t('contacts.import')}</button>
        <button class="btn" onclick={exportMenu} disabled={busy || !total} aria-haspopup="menu">{t('contacts.export')}</button>
      </div>
      {#if syncState}
        <div class="syncbar">
          {#if syncState.enabled}
            {@const st = syncState.enabled}
            <span class="sync-text">
              {#if st.running}{t('contacts.sync.running', { email: st.email })}
              {:else if st.lastSync}{t('contacts.sync.status', { email: st.email, time: listDate(st.lastSync) })}
              {:else}{t('contacts.sync.never', { email: st.email })}{/if}
              {#if st.lastError && !st.running}<span class="sync-error"> · {errorText({ code: st.lastError })}</span>{/if}
            </span>
            <span class="spacer"></span>
            {#if st.lastError === 'CONTACTS_PERMISSION'}<button class="btn btn-primary" onclick={() => void grant()} disabled={busy}>{t('contacts.sync.grant')}</button>{/if}
            <button class="btn" onclick={() => void runSync()} disabled={busy || st.running}><Icon name="sync" />{t('contacts.sync.now')}</button>
            <button class="btn" onclick={() => void disableSync()} disabled={busy}>{t('contacts.sync.off')}</button>
          {:else if syncState.candidates.length}
            {#if syncState.candidates.length > 1}
              <select bind:value={syncAccount} aria-label={t('contacts.sync.account')}>
                {#each syncState.candidates as c (c.accountId)}<option value={c.accountId}>{c.email}</option>{/each}
              </select>
            {/if}
            <button class="btn" onclick={() => void enableSync()} disabled={busy}><Icon name="sync" />{t('contacts.sync.with')}</button>
          {:else}
            <span class="sync-text">{t('contacts.sync.hint')}</span>
          {/if}
        </div>
      {/if}
      {#if message}<p class="message {message.tone}" role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>{/if}

      <div class="body" role="tabpanel">
        {#if tab === 'saved'}
          <ul class="list" aria-label={t('contacts.tabSaved')}>
            {#each contacts as c (c.id)}
              <li>
                <button class:active={c.id === selectedId} aria-current={c.id === selectedId ? 'true' : undefined} onclick={() => pick(c)}>
                  <strong>{c.name || c.email || c.phone}</strong>
                  {#if c.name && (c.email || c.phone)}<small>{c.email || c.phone}</small>{/if}
                </button>
              </li>
            {:else}
              <li class="none">{query ? t('contacts.noMatch') : t('contacts.empty')}</li>
            {/each}
          </ul>
          <div class="editor">
            {#if form}
              <form onsubmit={save}>
                <label class="field"><span>{t('contacts.name')}</span><input bind:value={form.name} maxlength="300" /></label>
                <label class="field"><span>{t('contacts.email')}</span><input bind:value={form.email} type="email" maxlength="320" /></label>
                <label class="field"><span>{t('contacts.phone')}</span><input bind:value={form.phone} type="tel" maxlength="200" /></label>
                <label class="field"><span>{t('contacts.company')}</span><input bind:value={form.company} maxlength="300" /></label>
                <label class="field"><span>{t('contacts.address')}</span><textarea bind:value={form.address} rows="3" maxlength="1000"></textarea></label>
                <label class="field"><span>{t('contacts.note')}</span><textarea bind:value={form.note} rows="4" maxlength="5000"></textarea></label>
                <div class="row">
                  {#if form.id}
                    {#if form.email.trim()}<button type="button" class="btn" onclick={() => write(form!.name, form!.email)} disabled={busy}><Icon name="compose" />{t('contacts.write')}</button>{/if}
                    {#if form.address.trim()}<button type="button" class="btn" onclick={copyAddress}>{t('contacts.copyAddress')}</button>{/if}
                    <button type="button" class="btn danger" onclick={remove} disabled={busy}>{t('contacts.delete')}</button>
                  {/if}
                  <span class="spacer"></span>
                  <button type="submit" class="btn btn-primary" disabled={busy}>{t('contacts.save')}</button>
                </div>
              </form>
            {:else}
              <p class="hint">{t('contacts.pick')}</p>
            {/if}
          </div>
        {:else}
          <ul class="list" aria-label={t('contacts.tabMail')}>
            {#each fromMail as m (m.email)}
              <li>
                <button class:active={m.email === selectedMail} aria-current={m.email === selectedMail ? 'true' : undefined} onclick={() => (selectedMail = m.email)}>
                  <strong>{m.name || m.email}</strong>
                  {#if m.name}<small>{m.email}</small>{/if}
                </button>
              </li>
            {:else}
              <li class="none">{query ? t('contacts.noMatch') : t('contacts.mailEmpty')}</li>
            {/each}
          </ul>
          <div class="editor">
            <p class="hint">{t('contacts.mailLead')}</p>
            {#if fromMail.length}
              <p><button class="btn" onclick={() => addFromMail(fromMail.map((m) => m.email))} disabled={busy}>{t('contacts.addAll', { n: fromMail.length })}</button></p>
            {/if}
            {#if mailItem}
              <div class="card">
                <strong>{mailItem.name || mailItem.email}</strong>
                {#if mailItem.name}<div>{mailItem.email}</div>{/if}
                <small>{t('contacts.sentCount', { n: mailItem.count })}</small>
                <div class="row">
                  <button class="btn" onclick={() => write(mailItem!.name, mailItem!.email)}><Icon name="compose" />{t('contacts.write')}</button>
                  <span class="spacer"></span>
                  <button class="btn btn-primary" onclick={() => addFromMail([mailItem!.email])} disabled={busy}>{t('contacts.addOne')}</button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgb(0 0 0 / 35%);
    z-index: 50;
  }
  .dialog {
    width: min(860px, 100%);
    height: min(640px, calc(100vh - 2rem));
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 12px 40px rgb(0 0 0 / 25%);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 1.2rem;
    padding: 0.9rem 1rem 0 1.4rem;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    margin: 0 0 0.6rem;
    font-size: 1.2rem;
    font-weight: 650;
  }
  .tabs {
    display: flex;
    gap: 0.2rem;
    align-self: flex-end;
  }
  [role='tab'] {
    border: 0;
    background: none;
    padding: 0.5rem 0.8rem;
    cursor: pointer;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
  }
  [role='tab'][aria-selected='true'] {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--accent);
  }
  .count {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
  }
  .x {
    margin-inline-start: auto;
    align-self: flex-start;
    border: 0;
    background: none;
    font-size: 1.4rem;
    line-height: 1;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
  }
  .x:hover {
    background: var(--surface-2);
  }
  .actions-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .actions-bar input {
    width: 240px;
    max-width: 100%;
  }
  .spacer {
    flex: 1;
  }
  .syncbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    font-size: 0.85rem;
    flex-wrap: wrap;
  }
  .sync-text {
    color: var(--text-muted);
  }
  .sync-error {
    color: var(--danger);
  }
  .syncbar .btn {
    padding: 0.3em 0.8em;
  }
  .message {
    margin: 0;
    padding: 0.45rem 1rem;
    font-size: 0.85rem;
    border-bottom: 1px solid var(--border);
  }
  .message.ok {
    background: color-mix(in srgb, var(--ok) 12%, var(--surface));
  }
  .message.error {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 280px 1fr;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0.4rem;
    border-inline-end: 1px solid var(--border);
    background: var(--surface-2);
    overflow: auto;
  }
  .list button {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: start;
    cursor: pointer;
    color: var(--text);
    min-width: 0;
  }
  .list button:hover {
    background: color-mix(in srgb, var(--text) 6%, transparent);
  }
  .list button.active {
    background: var(--accent-soft);
  }
  .list strong,
  .list small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list strong {
    font-weight: 600;
  }
  .list small {
    color: var(--text-muted);
  }
  .none {
    padding: 0.8rem 0.6rem;
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .editor {
    padding: 1rem 1.4rem;
    overflow: auto;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.75rem;
  }
  .field span {
    font-weight: 600;
    font-size: 0.85rem;
  }
  textarea {
    resize: vertical;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.4rem;
  }
  .hint {
    color: var(--text-muted);
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.8rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .card small {
    color: var(--text-muted);
  }
  .danger {
    color: var(--danger);
  }
</style>
