<script lang="ts">
  import type { AiConfigPatch, AiProvider } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { ai, aiErrorText, loadAiConfig, providerName } from '../lib/ai.svelte'

  /** Nastavenia → AI: poskytovateľ, kľúč (bezpečné úložisko), model, súkromie. */
  const PROVIDERS: AiProvider[] = ['anthropic', 'openrouter', 'local']
  const SUGGESTED: Record<AiProvider, string[]> = {
    anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    openrouter: [],
    local: []
  }
  const KEY_PAGES: Partial<Record<AiProvider, string>> = {
    anthropic: 'https://console.anthropic.com/settings/keys',
    openrouter: 'https://openrouter.ai/settings/keys'
  }

  let keyInput = $state('')
  let model = $state('')
  let baseUrl = $state('')
  let models = $state<string[]>([])
  let busy = $state(false)
  let status = $state<{ ok: boolean; text: string } | null>(null)

  void loadAiConfig().then((c) => {
    if (!c) return
    model = c.model
    baseUrl = c.baseUrl
  })

  const c = $derived(ai.config)

  async function set(patch: AiConfigPatch, okText?: string): Promise<boolean> {
    try {
      ai.config = await window.doar.invoke('ai.config.set', patch)
      model = ai.config.model
      baseUrl = ai.config.baseUrl
      status = okText ? { ok: true, text: okText } : null
      return true
    } catch (e) {
      status = { ok: false, text: aiErrorText(e) }
      return false
    }
  }

  async function changeProvider(p: AiProvider): Promise<void> {
    models = []
    keyInput = ''
    await set({ provider: p })
  }

  async function saveKey(): Promise<void> {
    if (!keyInput.trim()) return
    if (await set({ key: keyInput }, t('ai.settings.keySaved'))) keyInput = ''
  }

  async function loadModels(): Promise<void> {
    // Tlačidlo sa počas overovania nezablokuje – inak by stratilo zameranie a Escape by nezavrel okno.
    if (!c || busy) return
    busy = true
    status = null
    try {
      const r = await window.doar.invoke('ai.models', { provider: c.provider, baseUrl, key: keyInput.trim() || undefined })
      models = r.models
      status = { ok: true, text: t(c.provider === 'openrouter' ? 'ai.settings.modelsOkNoKey' : 'ai.settings.modelsOk', { n: r.models.length }) }
      if (keyInput.trim()) await set({ key: keyInput }, status.text).then((ok) => ok && (keyInput = ''))
      if (!model && r.models[0]) await set({ model: r.models[0] }, status.text)
    } catch (e) {
      status = { ok: false, text: aiErrorText(e) }
    } finally {
      busy = false
    }
  }

  const options = $derived([...new Set([...(models.length ? models : SUGGESTED[c?.provider ?? 'anthropic'])])])
</script>

{#if c}
  <fieldset class="field">
    <legend>{t('ai.settings.title')}</legend>
    <label class="check">
      <input type="checkbox" checked={c.enabled} onchange={(e) => void set({ enabled: (e.currentTarget as HTMLInputElement).checked })} />
      <span>{t('ai.settings.enable')}<small>{t('ai.settings.enableHint')}</small></span>
    </label>
  </fieldset>

  <fieldset class="field">
    <legend>{t('ai.settings.provider')}</legend>
    <select value={c.provider} aria-label={t('ai.settings.provider')} onchange={(e) => void changeProvider((e.currentTarget as HTMLSelectElement).value as AiProvider)}>
      {#each PROVIDERS as p (p)}<option value={p}>{providerName(p)}</option>{/each}
    </select>
    <p class="note">
      {t(`ai.settings.hint.${c.provider}` as MessageKey)}
      {#if KEY_PAGES[c.provider]}
        <button type="button" class="link" onclick={() => window.doar.openExternal(KEY_PAGES[c.provider]!)}>{t('ai.settings.getKey')}</button>
      {/if}
    </p>

    {#if c.provider === 'local'}
      <label class="stack">
        <span>{t('ai.settings.baseUrl')}</span>
        <input type="url" bind:value={baseUrl} spellcheck="false" onchange={() => void set({ baseUrl })} />
        <small>{t('ai.settings.baseUrlHint')}</small>
      </label>
    {/if}

    <div class="stack">
      <label for="ai-key">{c.provider === 'local' ? t('ai.settings.keyOptional') : t('ai.settings.key')}</label>
      <div class="inline">
        <input id="ai-key" type="password" autocomplete="off" spellcheck="false" bind:value={keyInput} placeholder={c.hasKey ? '••••••••' : ''} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), void saveKey())} />
        <button class="btn" disabled={!keyInput.trim()} onclick={() => void saveKey()}>{t('ai.settings.saveKey')}</button>
        {#if c.hasKey}<button class="btn" onclick={() => void set({ key: null }, t('ai.settings.keyRemoved'))}>{t('ai.settings.removeKey')}</button>{/if}
      </div>
      <small>
        {#if c.keyStorage === 'secure'}{t('ai.settings.keySecure')}{:else if c.keyStorage === 'session'}{t('ai.settings.keySession')}{:else}{t('ai.settings.keyNone')}{/if}
      </small>
    </div>

    <div class="stack">
      <label for="ai-model">{t('ai.settings.model')}</label>
      <div class="inline">
        <input id="ai-model" list="ai-models" bind:value={model} spellcheck="false" onchange={() => void set({ model })} />
        <datalist id="ai-models">{#each options as m (m)}<option value={m}></option>{/each}</datalist>
        <button class="btn" aria-busy={busy} onclick={() => void loadModels()}>{busy ? t('ai.settings.testing') : t('ai.settings.loadModels')}</button>
      </div>
    </div>
    {#if status}<p class="status" class:ok={status.ok} class:bad={!status.ok} role="status">{status.ok ? '✓' : '⚠'} {status.text}</p>{/if}
  </fieldset>

  <fieldset class="field">
    <legend>{t('ai.settings.privacy')}</legend>
    <label class="check">
      <input type="checkbox" checked={c.confirm} onchange={(e) => void set({ confirm: (e.currentTarget as HTMLInputElement).checked })} />
      <span>{t('ai.settings.confirm')}</span>
    </label>
    <p class="note">{t('ai.settings.privacyNote')}</p>
  </fieldset>
{/if}

<style>
  /* Rovnaký vzhľad ako ostatné časti Nastavení. */
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0 0 0.85rem;
    border: 0;
    padding: 0;
  }
  legend {
    font-weight: 600;
    font-size: 0.9rem;
    padding: 0;
    margin-bottom: 0.25rem;
  }
  .check {
    display: flex;
    gap: 0.55rem;
    align-items: flex-start;
  }
  .check span {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.6rem;
  }
  .stack > span,
  .stack > label {
    font-size: 0.9rem;
  }
  .inline {
    display: flex;
    gap: 0.4rem;
  }
  .inline input {
    flex: 1;
    min-width: 0;
  }
  input[type='url'],
  input[type='password'],
  input:not([type]),
  select {
    padding: 0.4em 0.55em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  small,
  .note {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .note {
    margin: 0.4rem 0 0;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: inherit;
  }
  .status {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
  }
  .status.ok {
    color: var(--ok);
  }
  .status.bad {
    color: var(--danger);
  }
</style>
