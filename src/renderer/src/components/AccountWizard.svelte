<script lang="ts">
  import { tick } from 'svelte'
  import type {
    AccountSettings,
    AccountSummary,
    ConnectionTestResult,
    DiscoveryResult,
    ProtocolTestResult,
    Security
  } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'

  let { onDone, onCancel }: { onDone: (acc: AccountSummary) => void; onCancel: () => void } = $props()

  type Step = 'identity' | 'discovering' | 'settings'
  let step = $state<Step>('identity')

  let displayName = $state('')
  let email = $state('')
  let password = $state('')
  let showErrors = $state(false)

  let discovery = $state<DiscoveryResult | null>(null)
  let settings = $state<AccountSettings | null>(null)
  let editing = $state(false)
  let busy = $state(false)
  let test = $state<ConnectionTestResult | null>(null)
  let error = $state<string | null>(null)
  let secureMissing = $state(false)
  let root: HTMLElement | undefined = $state()

  const emailValid = $derived(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))

  async function focusFirst(): Promise<void> {
    await tick()
    root?.querySelector<HTMLElement>('input:not([type=checkbox]), button.btn-primary')?.focus()
  }

  function errText(e: unknown): string {
    const code = (e as { code?: string })?.code
    const key = `errors.${code}` as MessageKey
    const translated = t(key)
    return translated !== key ? translated : t('errors.generic', { message: (e as Error)?.message ?? String(e) })
  }

  async function submitIdentity(ev: SubmitEvent): Promise<void> {
    ev.preventDefault()
    showErrors = true
    if (!emailValid || !password) return
    error = null
    step = 'discovering'
    try {
      discovery = await window.doar.invoke('accounts.discover', { email: email.trim(), displayName: displayName.trim() })
      settings = structuredClone($state.snapshot(discovery.settings)) as AccountSettings
      editing = discovery.source === 'none'
      test = null
      step = 'settings'
      await focusFirst()
    } catch (e) {
      error = errText(e)
      step = 'identity'
    }
  }

  function protoMessage(r: ProtocolTestResult): string {
    return r.ok ? t('wizard.ok') : t(`errors.${r.code ?? 'UNKNOWN'}` as MessageKey)
  }

  async function save(remember: boolean): Promise<void> {
    if (!settings) return
    const acc = await window.doar.invoke('accounts.add', {
      settings: $state.snapshot(settings) as AccountSettings,
      password,
      rememberPassword: remember
    })
    onDone(acc)
  }

  async function verifyAndSave(): Promise<void> {
    if (!settings || busy) return
    busy = true
    error = null
    test = null
    secureMissing = false
    try {
      test = await window.doar.invoke('accounts.test', { settings: $state.snapshot(settings) as AccountSettings, password })
      if (test.imap.ok && test.smtp.ok) await save(true)
      else editing = true
    } catch (e) {
      if ((e as { code?: string }).code === 'SECURE_STORAGE_UNAVAILABLE') secureMissing = true
      else error = errText(e)
    } finally {
      busy = false
    }
  }

  async function saveSessionOnly(): Promise<void> {
    busy = true
    try {
      await save(false)
    } catch (e) {
      error = errText(e)
    } finally {
      busy = false
    }
  }

  /** Návrhy serverov z certifikátu; *.m1.hosting.sk → imap.m1.hosting.sk / smtp.m1.hosting.sk. */
  function suggestHosts(names: string[], proto: 'imap' | 'smtp'): string[] {
    const out: string[] = []
    for (const h of names) {
      if (!h.includes('*')) out.push(h)
      else if (/^\*\.[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) out.push(`${proto}.${h.slice(2)}`, `mail.${h.slice(2)}`)
    }
    return [...new Set(out)]
  }

  function useHost(proto: 'imap' | 'smtp', host: string): void {
    if (!settings) return
    settings[proto].host = host
    // Hostingy s vlastným certifikátom používajú takmer vždy priame SSL/TLS.
    settings[proto].security = 'tls'
    settings[proto].port = proto === 'imap' ? 993 : 465
    test = null
  }

  function onSecurityChange(proto: 'imap' | 'smtp', value: Security): void {
    if (!settings) return
    const s = settings[proto]
    // Pri zmene zabezpečenia navrhneme zodpovedajúci štandardný port.
    const defaults = proto === 'imap' ? { tls: 993, starttls: 143 } : { tls: 465, starttls: 587 }
    if (s.port === defaults[s.security]) s.port = defaults[value]
    s.security = value
  }

  const sourceText = $derived(
    !discovery ? '' : discovery.source === 'none' ? t('wizard.notFound') : discovery.source === 'guess' ? t('wizard.guessed') : t('wizard.found')
  )

  $effect(() => {
    void focusFirst()
  })
</script>

<section class="wizard" bind:this={root} aria-labelledby="wizard-title">
  <div class="card">
    <h1 id="wizard-title">{t('wizard.title')}</h1>

    {#if step === 'identity' || step === 'discovering'}
      <form onsubmit={submitIdentity} novalidate>
        <p class="lead">{t('wizard.lead')}</p>
        <label class="field">
          <span>{t('wizard.name')}</span>
          <input type="text" bind:value={displayName} autocomplete="name" disabled={step === 'discovering'} />
          <small>{t('wizard.name.hint')}</small>
        </label>
        <label class="field">
          <span>{t('wizard.email')}</span>
          <input
            type="email"
            bind:value={email}
            autocomplete="email"
            required
            aria-invalid={showErrors && !emailValid}
            disabled={step === 'discovering'}
          />
          {#if showErrors && !emailValid}<small class="err">{t('errors.INVALID_EMAIL')}</small>{/if}
        </label>
        <label class="field">
          <span>{t('wizard.password')}</span>
          <input type="password" bind:value={password} autocomplete="current-password" required aria-invalid={showErrors && !password} disabled={step === 'discovering'} />
          {#if showErrors && !password}<small class="err">{t('wizard.required')}</small>{/if}
        </label>

        <p class="note">{t('wizard.discoveryNote')}</p>
        {#if error}<p class="alert error" role="alert">{error}</p>{/if}

        <div class="actions">
          <button type="button" class="btn" onclick={onCancel}>{t('wizard.cancel')}</button>
          <button type="submit" class="btn btn-primary" disabled={step === 'discovering'}>
            {step === 'discovering' ? t('wizard.discovering') : t('wizard.continue')}
          </button>
        </div>
      </form>
    {:else if step === 'settings' && settings && discovery}
      <p class="lead" aria-live="polite">{sourceText}</p>

      {#if discovery.unsupportedAuth}
        <p class="alert error" role="alert">{t('wizard.oauthUnsupported')}</p>
      {:else if discovery.needsAppPassword}
        <p class="alert info">{t('wizard.appPassword')}</p>
      {/if}

      {#if !editing}
        <dl class="summary">
          <dt>{t('wizard.incoming')}</dt>
          <dd>{settings.imap.host} · {settings.imap.port} · {t(`wizard.security.${settings.imap.security}`)}</dd>
          <dt>{t('wizard.outgoing')}</dt>
          <dd>{settings.smtp.host} · {settings.smtp.port} · {t(`wizard.security.${settings.smtp.security}`)}</dd>
          <dt>{t('wizard.username')}</dt>
          <dd>{settings.username}</dd>
        </dl>
      {:else}
        {#each [['imap', 'wizard.incoming'], ['smtp', 'wizard.outgoing']] as const as [proto, title] (proto)}
          <fieldset>
            <legend>{t(title)}</legend>
            <div class="row">
              <label class="field grow">
                <span>{t('wizard.server')}</span>
                <input type="text" bind:value={settings[proto].host} spellcheck="false" autocapitalize="off" />
              </label>
              <label class="field port">
                <span>{t('wizard.port')}</span>
                <input type="number" min="1" max="65535" bind:value={settings[proto].port} />
              </label>
              <label class="field sec">
                <span>{t('wizard.security')}</span>
                <select value={settings[proto].security} onchange={(e) => onSecurityChange(proto, (e.currentTarget as HTMLSelectElement).value as Security)}>
                  <option value="tls">{t('wizard.security.tls')}</option>
                  <option value="starttls">{t('wizard.security.starttls')}</option>
                </select>
              </label>
            </div>
          </fieldset>
        {/each}
        <div class="row">
          <label class="field grow">
            <span>{t('wizard.username')}</span>
            <input type="text" bind:value={settings.username} spellcheck="false" autocapitalize="off" />
            <small>{t('wizard.username.hint')}</small>
          </label>
          <label class="field grow">
            <span>{t('wizard.password')}</span>
            <input type="password" bind:value={password} autocomplete="current-password" />
          </label>
        </div>
        <label class="check">
          <input type="checkbox" bind:checked={settings.saveSentCopy} />
          <span>{t('wizard.saveSentCopy')}<small>{t('wizard.saveSentCopy.hint')}</small></span>
        </label>
      {/if}

      {#if busy && !test}<p class="note" aria-live="polite">{t('wizard.verifying')}</p>{/if}

      {#if test}
        <ul class="results" aria-live="polite">
          {#each [['imap', 'wizard.imap'], ['smtp', 'wizard.smtp']] as const as [proto, label] (proto)}
            {@const r = test[proto]}
            <li class={r.ok ? 'ok' : 'fail'}>
              <span class="icon" aria-hidden="true">{r.ok ? '✓' : '✕'}</span>
              <span><strong>{t(label)}:</strong> {protoMessage(r)}</span>
              {#if r.code === 'CERT_HOSTNAME' && r.certHosts?.length}
                <span class="suggest">
                  <small>{t('wizard.certValidFor', { names: r.certHosts.slice(0, 6).join(', ') })}</small>
                  {#each suggestHosts(r.certHosts, proto).slice(0, 3) as h (h)}
                    <button type="button" class="btn small" onclick={() => useHost(proto, h)}>{t('wizard.useCertHost', { host: h })}</button>
                  {/each}
                </span>
              {/if}
              {#if !r.ok && r.detail}
                <details><summary>{t('wizard.detail')}</summary><code>{r.detail}</code></details>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if secureMissing}
        <p class="alert info" role="alert">{t('wizard.secureStorageMissing')}</p>
      {/if}
      {#if error}<p class="alert error" role="alert">{error}</p>{/if}

      <div class="actions">
        <button type="button" class="btn" onclick={() => ((step = 'identity'), (test = null))} disabled={busy}>{t('wizard.back')}</button>
        {#if !editing}
          <button type="button" class="btn" onclick={() => (editing = true)} disabled={busy}>{t('wizard.editManually')}</button>
        {/if}
        <span class="spacer"></span>
        {#if secureMissing}
          <button type="button" class="btn btn-primary" onclick={saveSessionOnly} disabled={busy}>{t('wizard.rememberSession')}</button>
        {:else}
          <button type="button" class="btn btn-primary" onclick={verifyAndSave} disabled={busy || !!discovery.unsupportedAuth || !password}>
            {busy ? t('wizard.verifying') : t('wizard.verifyAndSave')}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .wizard {
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: 2rem 1rem;
  }
  .card {
    width: min(640px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 2rem;
    box-shadow: var(--shadow);
  }
  h1 {
    margin: 0 0 0.25rem;
    font-size: 1.4rem;
    font-weight: 650;
  }
  .lead {
    margin: 0 0 1.25rem;
    color: var(--text-muted);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.75rem;
  }
  .field > span {
    font-weight: 550;
    font-size: 0.9rem;
  }
  .field small,
  .check small {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .field small.err {
    color: var(--danger);
  }
  input[type='text'],
  input[type='email'],
  input[type='password'],
  input[type='number'],
  select {
    padding: 0.5em 0.65em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    width: 100%;
    min-width: 0;
  }
  input[aria-invalid='true'] {
    border-color: var(--danger);
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 0.9rem 0;
    margin: 0 0 0.9rem;
  }
  legend {
    padding: 0 0.35rem;
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1 1 200px;
    min-width: 0;
  }
  .port {
    flex: 0 0 6rem;
  }
  .sec {
    flex: 0 0 8rem;
  }
  .check {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    margin: 0.25rem 0 1rem;
  }
  .check span {
    display: flex;
    flex-direction: column;
  }
  .summary {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.4rem 1rem;
    margin: 0 0 1.25rem;
    padding: 0.9rem 1rem;
    background: var(--surface-2);
    border-radius: var(--radius);
  }
  .summary dt {
    color: var(--text-muted);
  }
  .summary dd {
    margin: 0;
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  .note {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .alert {
    padding: 0.6rem 0.8rem;
    border-radius: var(--radius-sm);
    margin: 0 0 1rem;
  }
  .alert.error {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--text);
    border-left: 3px solid var(--danger);
  }
  .alert.info {
    background: var(--accent-soft);
    border-left: 3px solid var(--accent);
  }
  .results {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
    display: grid;
    gap: 0.5rem;
  }
  .results li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
  }
  .results .icon {
    font-weight: 700;
  }
  .results .ok .icon {
    color: var(--ok);
  }
  .results .fail .icon {
    color: var(--danger);
  }
  .suggest small {
    width: 100%;
    color: var(--text-muted);
  }
  .suggest {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    width: 100%;
    padding-left: 1.3rem;
  }
  details {
    width: 100%;
    padding-left: 1.3rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  code {
    overflow-wrap: anywhere;
  }
  .btn.small {
    padding: 0.25em 0.6em;
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.5rem;
  }
  .spacer {
    flex: 1;
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
