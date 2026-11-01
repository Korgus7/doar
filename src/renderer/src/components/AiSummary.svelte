<script lang="ts">
  import Icon from './Icon.svelte'
  import { onDestroy, onMount, untrack } from 'svelte'
  import { t } from '../i18n/index.svelte'
  import { openSettings } from '../lib/settings.svelte'
  import { ai, aiErrorText, aiReady, aiTarget, aiUi, defaultTranslateLang, langLabel, runAi, summaries, TRANSLATE_LANGS, translations } from '../lib/ai.svelte'

  /**
   * Zhrnutie správy (panel nad správou) alebo preklad (pruh nad správou; preložený text sa zobrazí priamo
   * v správe s pôvodným rozložením). Len na pokyn; pred odoslaním (ak to používateľ nevypol) povie, čo a kam ide.
   */
  let { messageId, mode = 'summary', showRemote = false }: { messageId: number; mode?: 'summary' | 'translate'; showRemote?: boolean } = $props()

  const translate = untrack(() => mode === 'translate')
  let lang = $state(aiUi.translated?.id === untrack(() => messageId) ? aiUi.translated!.lang : defaultTranslateLang())
  const trKey = (l: string): string => `${messageId}:${l}:${showRemote ? 1 : 0}`
  const cachedSummary = untrack(() => (translate ? null : summaries.get(messageId)))
  const cachedTr = untrack(() => (translate ? translations.get(trKey(lang)) : null))
  let phase = $state<'confirm' | 'running' | 'done' | 'error'>(cachedSummary || cachedTr ? 'done' : ai.config?.confirm === false && aiReady(ai.config) ? 'running' : 'confirm')
  let text = $state(cachedSummary?.text ?? '')
  let target = $state(cachedSummary?.target ?? cachedTr?.target ?? aiTarget())
  let truncated = $state(cachedSummary?.truncated ?? cachedTr?.truncated ?? false)
  let error = $state<string | null>(null)
  let dontAsk = $state(false)
  /** Preklad: koľko úsekov už AI preložila (priebeh). */
  let done = $state(0)
  let cancel: (() => void) | null = null
  if (cachedTr) {
    aiUi.translated = cachedTr
    aiUi.showOriginal = false
  }

  async function start(): Promise<void> {
    if (dontAsk && ai.config) ai.config = await window.doar.invoke('ai.config.set', { confirm: false }).catch(() => ai.config)
    cancel?.()
    phase = 'running'
    text = ''
    done = 0
    error = null
    target = aiTarget()
    const forLang = lang
    const job = translate
      ? runAi({ task: 'translate', messageId, targetLang: forLang, showRemote }, (soFar) => (done = Math.max(0, (soFar.match(/⟦\d+⟧/g) ?? []).length - 1)))
      : runAi({ task: 'summary', messageId }, (soFar) => (text = soFar))
    cancel = job.cancel
    try {
      const r = await job.result
      if (translate && forLang !== lang) return
      truncated = r.truncated
      if (translate) {
        const tr = { id: messageId, lang: forLang, html: r.html ?? '', subject: r.subject ?? '', target, truncated }
        translations.set(trKey(forLang), tr)
        aiUi.translated = tr
        aiUi.showOriginal = false
      } else {
        text = r.text
        summaries.set(messageId, { text, target, truncated })
      }
      phase = 'done'
    } catch (e) {
      if ((e as { code?: string }).code === 'AI_CANCELLED') {
        if (forLang === lang) phase = translate && aiUi.translated?.id === messageId ? 'done' : 'confirm'
      } else {
        phase = 'error'
        error = aiErrorText(e)
      }
    } finally {
      cancel = null
    }
  }

  /** Iný jazyk prekladu: hotový preklad z pamäte, inak preložiť (bez ďalšej otázky – súhlas už bol). */
  function changeLang(next: string): void {
    lang = next
    const c = translations.get(trKey(next))
    if (c) {
      cancel?.()
      aiUi.translated = c
      aiUi.showOriginal = false
      target = c.target
      truncated = c.truncated
      phase = 'done'
    } else if (phase !== 'confirm') void start()
  }

  function close(): void {
    cancel?.()
    if (translate) {
      if (aiUi.translated?.id === messageId) aiUi.translated = null
      aiUi.showOriginal = false
      if (aiUi.translateFor === messageId) aiUi.translateFor = null
    } else if (aiUi.summaryFor === messageId) aiUi.summaryFor = null
  }

  onMount(() => {
    if (phase === 'running' && aiReady(ai.config)) void start()
  })
  onDestroy(() => {
    cancel?.()
    if (translate && aiUi.translated?.id === messageId && aiUi.translateFor !== messageId) aiUi.translated = null
  })
</script>

{#snippet langSelect()}
  <select value={lang} aria-label={t('ai.compose.translateTo')} onchange={(e) => changeLang(e.currentTarget.value)}>
    {#each TRANSLATE_LANGS as l (l)}<option value={l}>{langLabel(l)}</option>{/each}
  </select>
{/snippet}

{#if translate}
  <!-- Preklad: nízky pruh nad správou, samotný preklad je priamo v správe. -->
  <section class="bar" aria-label={t('ai.translate.title')} aria-live="polite">
    <Icon name="ai" size={14} />
    {#if !aiReady(ai.config)}
      <span>{t('ai.translate.needsAi')}</span>
      <button class="btn small btn-primary" onclick={() => (close(), openSettings({ tab: 'ai' }))}>{t('ai.translate.openSettings')}</button>
    {:else if phase === 'confirm'}
      <span>{t('ai.translate.confirm', { target: aiTarget(), lang: langLabel(lang) })}</span>
      {@render langSelect()}
      <button class="btn small btn-primary" onclick={() => void start()}>{t('ai.translate.send')}</button>
      <label class="check"><input type="checkbox" bind:checked={dontAsk} /> {t('ai.summary.dontAsk')}</label>
    {:else if phase === 'running'}
      <span>{t('ai.translate.running', { lang: langLabel(lang) })}{done ? ` (${done})` : ''}</span>
      <button class="btn small" onclick={() => cancel?.()}>{t('ai.stop')}</button>
    {:else if phase === 'error'}
      <span class="error" role="alert">{error}</span>
      <button class="btn small" onclick={() => void start()}>{t('ai.again')}</button>
    {:else}
      <strong>{aiUi.showOriginal ? t('ai.translate.original') : t('ai.translate.done', { lang: langLabel(lang) })}</strong>
      {@render langSelect()}
      <button class="btn small" onclick={() => (aiUi.showOriginal = !aiUi.showOriginal)}>{aiUi.showOriginal ? t('ai.translate.showTranslation') : t('ai.translate.showOriginal')}</button>
      <span class="muted">{target} · {t('ai.mayErr')}{truncated ? ` · ${t('ai.translate.partial')}` : ''}</span>
    {/if}
    <button class="x" aria-label={t('ai.translate.close')} title={t('ai.translate.close')} onclick={close}>×</button>
  </section>
{:else}
  <section class="sum" aria-label={t('ai.summary.title')} aria-live="polite">
    {#if phase === 'confirm'}
      <p><Icon name="ai" size={15} /> {t('ai.summary.confirm', { target: aiTarget() })}</p>
      <div class="acts">
        <button class="btn small btn-primary" onclick={() => void start()}>{t('ai.summary.send')}</button>
        <button class="btn small" onclick={close}>{t('ai.cancel')}</button>
        <label class="check"><input type="checkbox" bind:checked={dontAsk} /> {t('ai.summary.dontAsk')}</label>
      </div>
    {:else}
      <div class="head">
        <strong><Icon name="ai" size={15} /> {t('ai.summary.title')}</strong>
        <span class="muted">{target} · {t('ai.mayErr')}</span>
        <button class="x" aria-label={t('ai.summary.close')} title={t('ai.summary.close')} onclick={close}>×</button>
      </div>
      {#if phase === 'error'}
        <p class="error" role="alert">{error}</p>
        <div class="acts"><button class="btn small" onclick={() => void start()}>{t('ai.again')}</button></div>
      {:else}
        <p class="text">{text || '…'}</p>
        {#if phase === 'running'}
          <div class="acts"><span class="muted">{t('ai.working')}</span><button class="btn small" onclick={() => cancel?.()}>{t('ai.stop')}</button></div>
        {:else}
          {#if truncated}<p class="warn">{t('ai.truncated')}</p>{/if}
          <div class="acts"><button class="btn small" onclick={() => void start()}>{t('ai.again')}</button></div>
        {/if}
      {/if}
    {/if}
  </section>
{/if}

<style>
  .sum {
    margin-top: 0.6rem;
    padding: 0.55rem 0.8rem;
    border: 1px solid var(--border);
    border-inline-start: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    font-size: 0.9rem;
  }
  p {
    margin: 0 0 0.4rem;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    margin-bottom: 0.3rem;
  }
  .text {
    white-space: pre-wrap;
    user-select: text;
    max-height: 30vh;
    overflow: auto;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem 0.5rem;
    margin-top: 0.5rem;
    padding: 0.2rem 0.3rem 0.2rem 0.6rem;
    border: 1px solid var(--border);
    border-inline-start: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    font-size: 0.8rem;
  }
  .bar .x {
    margin-inline-start: auto;
  }
  .bar .btn.small {
    padding: 0.05em 0.5em;
    font-size: 0.76rem;
  }
  select {
    padding: 0.1rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font-size: 0.82rem;
  }
  .muted {
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .x {
    margin-inline-start: auto;
    border: 0;
    background: none;
    font-size: 1.15rem;
    line-height: 1;
    cursor: pointer;
    color: var(--text-muted);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .check {
    display: inline-flex;
    gap: 0.3rem;
    align-items: center;
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .btn.small {
    padding: 0.2em 0.65em;
    font-size: 0.82rem;
  }
  .warn {
    font-size: 0.8rem;
    color: var(--warning);
  }
  .error {
    color: var(--danger);
  }
</style>
