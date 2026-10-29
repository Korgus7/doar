<script lang="ts">
  import { upd, checkUpdates } from '../lib/update.svelte'
  import { timeOnly } from '../lib/format'
  import { tick } from 'svelte'
  import type { AccountDetails, AppSettings, ConnectionTestResult, ServerSettings } from '../../../shared/ipc'
  import { ACCOUNT_COLORS_MUTED, ACCOUNT_COLORS_VIVID, ACCOUNT_COLOR_NEUTRAL, LOCALE_NAMES } from '../../../shared/ipc'
  import { t, setLocale, localeChoice, AVAILABLE_LOCALES, type Locale, type MessageKey } from '../i18n/index.svelte'
  import { mail, loadAccounts, selectFolder, setThreads } from '../lib/mail.svelte'
  import { errorText, showToast } from '../lib/actions.svelte'
  import { settingsUi } from '../lib/settings.svelte'
  import RulesSettings from './RulesSettings.svelte'
  import SignaturesEditor from './SignaturesEditor.svelte'
  import AiSettings from './AiSettings.svelte'
  import { oauthProviderName, oauthSignIn } from '../lib/oauth.svelte'
  import { setTheme, themeChoice, type ThemeChoice } from '../lib/theme'

  let dialogEl: HTMLDivElement | undefined = $state()
  let shortcutsDone = $state<'ok' | 'failed' | null>(null)
  let details = $state<AccountDetails | null>(null)
  let form = $state({ displayName: '', name: '', color: '', saveSentCopy: true })
  let server = $state({ username: '', imap: { host: '', port: 993, security: 'tls' } as ServerSettings, smtp: { host: '', port: 465, security: 'tls' } as ServerSettings, password: '' })
  let serverOpen = $state(false)
  let busy = $state(false)
  let message = $state<{ text: string; tone: 'ok' | 'error' } | null>(null)
  let serverResult = $state<{ ok: boolean; test: ConnectionTestResult | null; text: string } | null>(null)
  let app = $state<AppSettings | null>(null)
  let lang = $state<Locale | 'auto'>('auto')
  let theme = $state<ThemeChoice>('system')

  const selectedId = $derived(settingsUi.accountId ?? mail.accounts[0]?.id ?? null)

  $effect(() => {
    if (!settingsUi.open) return
    void tick().then(() => dialogEl?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus())
    void window.doar.invoke('settings.get').then((s) => (app = s))
    lang = localeChoice()
    theme = themeChoice()
  })

  $effect(() => {
    const id = selectedId
    if (!settingsUi.open || id === null) return
    void load(id)
  })

  async function load(id: number): Promise<void> {
    message = null
    serverResult = null
    serverOpen = false
    try {
      const d = await window.doar.invoke('accounts.get', { id })
      details = d
      form = { displayName: d.displayName, name: d.name, color: d.color, saveSentCopy: d.saveSentCopy }
      server = { username: d.username, imap: { ...d.imap }, smtp: { ...d.smtp }, password: '' }
    } catch (e) {
      details = null
      message = { text: errorText(e), tone: 'error' }
    }
  }

  function close(): void {
    settingsUi.open = false
  }

  async function saveAccount(e: SubmitEvent): Promise<void> {
    e.preventDefault()
    if (!details || busy) return
    busy = true
    message = null
    try {
      await window.doar.invoke('accounts.update', { id: details.id, patch: { ...form } })
      await loadAccounts()
      message = { text: t('account.saved'), tone: 'ok' }
    } catch (err) {
      message = { text: errorText(err), tone: 'error' }
    } finally {
      busy = false
    }
  }

  function protoText(r: ConnectionTestResult['imap']): string {
    if (r.ok) return t('wizard.ok')
    const key = `errors.${r.code ?? 'UNKNOWN'}` as MessageKey
    return t(key) !== key ? t(key) : t('errors.UNKNOWN')
  }

  /** Konto prihlásené cez Microsoft/Google: nové prihlásenie (vypršané alebo zrušené prihlásenie). */
  async function reauth(): Promise<void> {
    if (!details?.oauthProvider || busy) return
    busy = true
    serverResult = null
    try {
      const r = await oauthSignIn(details.oauthProvider, details.email, undefined, { contacts: details.oauthProvider === 'google' })
      await window.doar.invoke('accounts.reauth', { id: details.id, flowId: r.flowId })
      serverResult = { ok: true, test: null, text: t('account.reauthDone') }
    } catch (err) {
      serverResult = { ok: false, test: null, text: errorText(err) }
    } finally {
      busy = false
    }
  }

  async function saveServer(e: SubmitEvent): Promise<void> {
    e.preventDefault()
    if (!details || busy) return
    busy = true
    serverResult = null
    try {
      const r = await window.doar.invoke('accounts.updateServer', {
        id: details.id,
        username: server.username,
        imap: { ...server.imap, port: Number(server.imap.port) },
        smtp: { ...server.smtp, port: Number(server.smtp.port) },
        password: server.password || undefined
      })
      serverResult = { ok: r.saved, test: r.test, text: r.saved ? t('account.serverSaved') : t('account.serverFailed') }
      if (r.saved) server.password = ''
    } catch (err) {
      serverResult = { ok: false, test: null, text: errorText(err) }
    } finally {
      busy = false
    }
  }

  async function removeAccount(): Promise<void> {
    if (!details || busy) return
    const d = details
    const q = t('account.removeConfirm', { email: d.email }) + (d.pendingOutbox ? `\n\n${t('account.removePending', { n: d.pendingOutbox })}` : '')
    if (!confirm(q)) return
    busy = true
    try {
      await window.doar.invoke('accounts.remove', { id: d.id })
      settingsUi.accountId = null
      details = null
      await loadAccounts()
      await selectFolder(null)
      showToast(t('account.removed', { email: d.email }))
      if (!mail.accounts.length) close()
    } catch (err) {
      message = { text: errorText(err), tone: 'error' }
    } finally {
      busy = false
    }
  }

  async function setApp(patch: Partial<AppSettings>): Promise<void> {
    app = await window.doar.invoke('settings.set', patch)
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  function tabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const tabs = ['accounts', 'general', 'rules', 'ai'] as const
    settingsUi.tab = tabs[(tabs.indexOf(settingsUi.tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!
    void tick().then(() => dialogEl?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus())
  }
</script>

<svelte:window
  onkeydown={(e) => {
    // Escape aj keď fokus nie je v okne (napr. tlačidlo sa počas práce vyplo alebo po systémovom potvrdení).
    if (settingsUi.open && e.key === 'Escape' && !dialogEl?.contains(e.target as Node)) {
      e.preventDefault()
      close()
    }
  }}
/>

{#if settingsUi.open}
  <div class="overlay" role="presentation">
    <div class="dialog" bind:this={dialogEl} role="dialog" aria-modal="true" aria-labelledby="set-title" tabindex="-1" onkeydown={onKey}>
      <header>
        <h1 id="set-title">{t('settings.title')}</h1>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={settingsUi.tab === 'accounts'} tabindex={settingsUi.tab === 'accounts' ? 0 : -1} onclick={() => (settingsUi.tab = 'accounts')} onkeydown={tabKey}>{t('settings.tabAccounts')}</button>
          <button role="tab" aria-selected={settingsUi.tab === 'general'} tabindex={settingsUi.tab === 'general' ? 0 : -1} onclick={() => (settingsUi.tab = 'general')} onkeydown={tabKey}>{t('settings.tabGeneral')}</button>
          <button role="tab" aria-selected={settingsUi.tab === 'rules'} tabindex={settingsUi.tab === 'rules' ? 0 : -1} onclick={() => (settingsUi.tab = 'rules')} onkeydown={tabKey}>{t('settings.tabRules')}</button>
          <button role="tab" aria-selected={settingsUi.tab === 'ai'} tabindex={settingsUi.tab === 'ai' ? 0 : -1} onclick={() => (settingsUi.tab = 'ai')} onkeydown={tabKey}>{t('settings.tabAi')}</button>
        </div>
        <button class="x" aria-label={t('settings.close')} title={t('settings.close')} onclick={close}>×</button>
      </header>

      {#if settingsUi.tab === 'accounts'}
        <div class="accounts" role="tabpanel">
          <ul class="acc-list" aria-label={t('settings.tabAccounts')}>
            {#each mail.accounts as a (a.id)}
              <li>
                <button class:active={a.id === selectedId} aria-current={a.id === selectedId ? 'true' : undefined} onclick={() => (settingsUi.accountId = a.id)}>
                  <span class="dot" style:background={a.color} aria-hidden="true"></span>
                  <span class="acc-text"><strong>{a.name}</strong><small>{a.email}</small></span>
                </button>
              </li>
            {/each}
          </ul>

          {#if details}
            <div class="editor">
              <form onsubmit={saveAccount}>
                <h2>{details.email}</h2>
                {#if details.passwordStorage === 'session'}<p class="note">ℹ {t('account.sessionPassword')}</p>{/if}
                <label class="field">
                  <span>{t('account.displayName')}</span>
                  <input bind:value={form.displayName} maxlength="200" />
                  <small>{t('account.displayNameHint')}</small>
                </label>
                <label class="field">
                  <span>{t('account.name')}</span>
                  <input bind:value={form.name} maxlength="100" required />
                  <small>{t('account.nameHint')}</small>
                </label>
                <fieldset class="field">
                  <legend>{t('account.color')}</legend>
                  {#each [ACCOUNT_COLORS_VIVID, [...ACCOUNT_COLORS_MUTED, ACCOUNT_COLOR_NEUTRAL]] as row, r (r)}
                    <div class="swatches">
                      {#each row as c, i (c)}
                        {@const n = r * ACCOUNT_COLORS_VIVID.length + i + 1}
                        <label class="swatch" style:background={c} title={t('account.colorPick', { n })}>
                          <input type="radio" name="color" value={c} bind:group={form.color} aria-label={t('account.colorPick', { n })} />
                        </label>
                      {/each}
                    </div>
                  {/each}
                </fieldset>
                {#if details.protocol !== 'graph'}
                  <label class="check">
                    <input type="checkbox" bind:checked={form.saveSentCopy} />
                    <span>{t('wizard.saveSentCopy')}<small>{t('wizard.saveSentCopy.hint')}</small></span>
                  </label>
                {/if}
                <div class="row">
                  <button class="btn btn-primary" type="submit" disabled={busy}>{t('account.save')}</button>
                  {#if message}<span class="msg" class:error={message.tone === 'error'} role="status">{message.text}</span>{/if}
                </div>
              </form>

              <SignaturesEditor accountId={details.id} />

              {#if details.protocol === 'graph'}
                <details class="server" bind:open={serverOpen}>
                  <summary>{t('account.server')}</summary>
                  <p class="note">{t('account.viaGraph')}</p>
                  <div class="field">
                    <span>{t('account.oauthVia', { provider: oauthProviderName(details.oauthProvider) })}</span>
                    <div><button class="btn" type="button" onclick={() => void reauth()} disabled={busy}>{t('account.reauth', { provider: oauthProviderName(details.oauthProvider) })}</button></div>
                  </div>
                  {#if serverResult}
                    <div class="result" class:error={!serverResult.ok} role="status"><p>{serverResult.text}</p></div>
                  {/if}
                </details>
              {:else}
              <details class="server" bind:open={serverOpen}>
                <summary>{t('account.server')}</summary>
                <p class="note">{t('account.serverHint')}</p>
                <form onsubmit={saveServer}>
                  <label class="field">
                    <span>{t('wizard.username')}</span>
                    <input bind:value={server.username} autocomplete="off" spellcheck="false" />
                  </label>
                  {#each [{ key: 'imap', title: t('wizard.incoming') }, { key: 'smtp', title: t('wizard.outgoing') }] as p (p.key)}
                    {@const s = server[p.key as 'imap' | 'smtp']}
                    <fieldset class="srv">
                      <legend>{p.title}</legend>
                      <label class="field grow"><span>{t('wizard.server')}</span><input bind:value={s.host} spellcheck="false" autocomplete="off" /></label>
                      <label class="field port"><span>{t('wizard.port')}</span><input bind:value={s.port} type="number" min="1" max="65535" /></label>
                      <label class="field sec">
                        <span>{t('wizard.security')}</span>
                        <select bind:value={s.security}>
                          <option value="tls">{t('wizard.security.tls')}</option>
                          <option value="starttls">{t('wizard.security.starttls')}</option>
                        </select>
                      </label>
                    </fieldset>
                  {/each}
                  {#if details.authType === 'oauth2'}
                    <div class="field">
                      <span>{t('account.oauthVia', { provider: oauthProviderName(details.oauthProvider) })}</span>
                      <div><button class="btn" type="button" onclick={() => void reauth()} disabled={busy}>{t('account.reauth', { provider: oauthProviderName(details.oauthProvider) })}</button></div>
                    </div>
                  {:else}
                    <label class="field">
                      <span>{t('account.newPassword')}</span>
                      <input bind:value={server.password} type="password" autocomplete="new-password" />
                      <small>{t('account.newPasswordHint')}</small>
                    </label>
                  {/if}
                  <div class="row">
                    <button class="btn" type="submit" disabled={busy}>{busy ? t('account.verifying') : t('account.verifySave')}</button>
                  </div>
                  {#if serverResult}
                    <div class="result" class:error={!serverResult.ok} role="status">
                      <p>{serverResult.text}</p>
                      {#if serverResult.test && !serverResult.ok}
                        <ul>
                          <li>{t('wizard.imap')}: {protoText(serverResult.test.imap)}</li>
                          <li>{t('wizard.smtp')}: {protoText(serverResult.test.smtp)}</li>
                        </ul>
                      {/if}
                    </div>
                  {/if}
                </form>
              </details>
              {/if}

              <div class="danger-zone">
                <button class="btn danger" onclick={removeAccount} disabled={busy}>{t('account.remove')}</button>
              </div>
            </div>
          {/if}
        </div>
      {:else if settingsUi.tab === 'ai'}
        <div class="general" role="tabpanel">
          <AiSettings />
        </div>
      {:else if settingsUi.tab === 'rules'}
        <div class="general" role="tabpanel">
          <RulesSettings />
        </div>
      {:else}
        <div class="general" role="tabpanel">
          <label class="field">
            <span>{t('settings.language')}</span>
            <select
              value={lang}
              onchange={(e) => {
                lang = (e.currentTarget as HTMLSelectElement).value as Locale | 'auto'
                setLocale(lang)
              }}
            >
              <option value="auto">{t('settings.language.auto')}</option>
              {#each AVAILABLE_LOCALES as l (l)}<option value={l}>{LOCALE_NAMES[l]}</option>{/each}
            </select>
          </label>
          <label class="field">
            <span>{t('settings.theme')}</span>
            <select
              value={theme}
              onchange={(e) => {
                theme = (e.currentTarget as HTMLSelectElement).value as ThemeChoice
                setTheme(theme)
              }}
            >
              <option value="system">{t('settings.theme.system')}</option>
              <option value="light">{t('settings.theme.light')}</option>
              <option value="dark">{t('settings.theme.dark')}</option>
            </select>
          </label>
          {#if app}
            <fieldset class="field">
              <legend>{t('general.list')}</legend>
              <label class="check">
                <input
                  type="checkbox"
                  checked={app.threads}
                  onchange={async (e) => {
                    await setThreads((e.currentTarget as HTMLInputElement).checked)
                    app = await window.doar.invoke('settings.get')
                  }}
                />
                <span>{t('general.threads')}<small>{t('general.threadsHint')}</small></span>
              </label>
            </fieldset>
            <fieldset class="field">
              <legend>{t('general.compose')}</legend>
              <label class="check">
                <input type="checkbox" checked={app.composeHtml} onchange={(e) => void setApp({ composeHtml: (e.currentTarget as HTMLInputElement).checked })} />
                <span>{t('general.composeHtml')}<small>{t('general.composeHtmlHint')}</small></span>
              </label>
            </fieldset>
            <fieldset class="field">
              <legend>{t('general.notifications')}</legend>
              <label class="check">
                <input type="checkbox" checked={app.notifyNewMail} onchange={(e) => void setApp({ notifyNewMail: (e.currentTarget as HTMLInputElement).checked })} />
                <span>{t('general.notifyNewMail')}</span>
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  checked={app.notifyShowContent}
                  disabled={!app.notifyNewMail}
                  onchange={(e) => void setApp({ notifyShowContent: (e.currentTarget as HTMLInputElement).checked })}
                />
                <span>{t('general.notifyShowContent')}<small>{t('general.notifyShowContentHint')}</small></span>
              </label>
            </fieldset>
          {/if}
          {#if upd.s}
            {@const u = upd.s}
            <fieldset class="field">
              <legend>{t('general.updates')}</legend>
              <p class="note">{t('general.version', { version: u.current })}{#if u.lastCheck} · {t('general.lastCheck', { time: timeOnly(u.lastCheck) })}{/if}</p>
              <label class="check">
                <input type="checkbox" checked={u.auto} onchange={(e) => window.doar.updateSetAuto((e.currentTarget as HTMLInputElement).checked)} />
                <span>{t('general.updatesAuto')}<small>{t('general.updatesPrivacy')}</small></span>
              </label>
              <div>
                <button class="btn" disabled={u.phase === 'checking' || u.phase === 'downloading' || u.phase === 'installing'} onclick={checkUpdates}>{t('general.updatesCheck')}</button>
              </div>
            </fieldset>
          {/if}
          {#if upd.s?.canInstall}
            <fieldset class="field">
              <legend>{t('general.shortcuts')}</legend>
              <div>
                <button
                  class="btn"
                  onclick={async () => {
                    shortcutsDone = (await window.doar.recreateShortcuts().catch(() => false)) ? 'ok' : 'failed'
                  }}>{t('general.shortcutsCreate')}</button
                >
              </div>
              {#if shortcutsDone}<p class="note">{shortcutsDone === 'ok' ? t('general.shortcutsDone') : t('general.shortcutsFailed')}</p>{/if}
            </fieldset>
          {/if}
        </div>
      {/if}
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
  .accounts {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 230px 1fr;
  }
  .acc-list {
    list-style: none;
    margin: 0;
    padding: 0.6rem 0.4rem;
    border-inline-end: 1px solid var(--border);
    background: var(--surface-2);
    overflow: auto;
  }
  .acc-list button {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: start;
    cursor: pointer;
    color: var(--text);
  }
  .acc-list button.active {
    background: var(--accent-soft);
  }
  .dot {
    flex: 0 0 10px;
    height: 10px;
    border-radius: var(--radius);
  }
  .acc-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .acc-text small {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .editor,
  .general {
    overflow: auto;
    padding: 1rem 1.4rem 1.4rem;
  }
  .general {
    flex: 1;
  }
  h2 {
    margin: 0 0 0.8rem;
    font-size: 1.05rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0 0 0.85rem;
    border: 0;
    padding: 0;
  }
  .field > span,
  legend {
    font-weight: 600;
    font-size: 0.9rem;
    padding: 0;
    margin-bottom: 0.25rem;
  }
  small {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  input:not([type='checkbox']):not([type='radio']),
  select {
    padding: 0.42em 0.55em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  .swatches {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .swatches + .swatches {
    margin-top: 0.5rem;
  }
  .swatch {
    width: 1.7rem;
    height: 1.7rem;
    border-radius: var(--radius);
    display: grid;
    place-items: center;
    cursor: pointer;
    border: 2px solid transparent;
  }
  .swatch:has(input:checked) {
    border-color: var(--text);
    box-shadow: inset 0 0 0 2px var(--surface);
  }
  .swatch:has(input:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .swatch input {
    opacity: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    cursor: pointer;
  }
  .check {
    display: flex;
    gap: 0.55rem;
    align-items: flex-start;
    margin-bottom: 0.7rem;
  }
  .check span {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .row {
    display: flex;
    gap: 0.8rem;
    align-items: center;
  }
  .msg {
    font-size: 0.88rem;
    color: var(--ok);
  }
  .msg.error,
  .result.error {
    color: var(--danger);
  }
  .note {
    margin: 0 0 0.8rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .server {
    margin-top: 1.4rem;
    border-top: 1px solid var(--border);
    padding-top: 0.9rem;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    margin-bottom: 0.6rem;
  }
  .srv {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.6rem 0.8rem 0;
    margin: 0 0 0.8rem;
  }
  .srv legend {
    padding: 0 0.3rem;
  }
  .grow {
    flex: 1 1 14rem;
  }
  .port {
    flex: 0 0 6rem;
  }
  .sec {
    flex: 0 0 9rem;
  }
  .result {
    margin-top: 0.7rem;
    font-size: 0.88rem;
    color: var(--ok);
  }
  .result p {
    margin: 0 0 0.3rem;
  }
  .result ul {
    margin: 0;
    padding-inline-start: 1.2rem;
  }
  .danger-zone {
    margin-top: 1.4rem;
    border-top: 1px solid var(--border);
    padding-top: 0.9rem;
  }
  .btn.danger {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }
</style>
