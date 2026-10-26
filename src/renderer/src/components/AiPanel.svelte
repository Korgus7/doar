<script lang="ts">
  import Icon from './Icon.svelte'
  import { onMount } from 'svelte'
  import type { AiRewriteStyle } from '../../../shared/ipc'
  import { t, i18n } from '../i18n/index.svelte'
  import { ai, aiErrorText, aiTarget, runAi, type AiSource } from '../lib/ai.svelte'

  /**
   * AI v okne správy: návrh odpovede a úpravy textu. Výsledok je len návrh – používateľ ho vloží
   * do správy (Ctrl+Z vráti späť) a správu odošle sám.
   */
  let {
    replyTo,
    getSource,
    apply,
    disabled = false,
    onclose
  }: {
    replyTo: number | null
    getSource: () => AiSource | null
    apply: (src: AiSource, text: string) => boolean
    disabled?: boolean
    onclose: () => void
  } = $props()

  type Action = 'reply' | AiRewriteStyle
  const LANGS = ['en', 'sk', 'cs', 'de', 'hu', 'pl', 'uk', 'fr', 'es', 'it', 'ru', 'he']

  let instruction = $state('')
  let targetLang = $state(i18n.locale === 'en' ? 'sk' : 'en')
  let phase = $state<'idle' | 'running' | 'done' | 'error'>('idle')
  let action = $state<Action | null>(null)
  let output = $state('')
  let error = $state<string | null>(null)
  let truncated = $state(false)
  let notApplied = $state(false)
  let source = $state<AiSource | null>(null)
  let cancel: (() => void) | null = null
  /** Čo sa práve dá odoslať (prepočíta sa pri otvorení a po každej akcii). */
  let preview = $state<AiSource | null>(null)
  onMount(() => refresh())

  const langName = (code: string): string => {
    try {
      return new Intl.DisplayNames([i18n.locale], { type: 'language' }).of(code) ?? code
    } catch {
      return code
    }
  }

  function refresh(): void {
    preview = getSource()
  }

  async function start(a: Action): Promise<void> {
    if (phase === 'running' || disabled) return
    const src = getSource()
    preview = src
    if (!src) return
    if (a !== 'reply' && !src.text.trim()) {
      phase = 'error'
      error = t('ai.compose.noText')
      return
    }
    source = src
    action = a
    output = ''
    error = null
    notApplied = false
    truncated = false
    phase = 'running'
    const job = runAi(
      a === 'reply'
        ? { task: 'reply', messageId: replyTo ?? undefined, text: src.text, instruction }
        : { task: 'rewrite', text: src.text, style: a, targetLang, instruction },
      (soFar) => (output = soFar)
    )
    cancel = job.cancel
    try {
      const r = await job.result
      output = r.text
      truncated = r.truncated
      phase = 'done'
    } catch (e) {
      if ((e as { code?: string }).code === 'AI_CANCELLED') {
        phase = output ? 'done' : 'idle'
      } else {
        phase = 'error'
        error = aiErrorText(e)
      }
    } finally {
      cancel = null
    }
  }

  function insert(): void {
    if (!source || !output.trim()) return
    if (apply(source, output.trim())) {
      phase = 'idle'
      output = ''
      source = null
      refresh()
    } else notApplied = true
  }

  function discard(): void {
    phase = 'idle'
    output = ''
    error = null
    source = null
    refresh()
  }

  const scopeText = $derived(
    !preview ? '' : preview.selection ? t('ai.compose.scopeSelection') : t('ai.compose.scopeOwn')
  )
</script>

<section class="ai" aria-label={t('ai.compose.title')}>
  <div class="row">
    {#if replyTo !== null}
      <button class="btn small btn-primary" disabled={disabled || phase === 'running'} onclick={() => void start('reply')} onmouseenter={refresh} onfocus={refresh}><Icon name="ai" size={15} />{t('ai.compose.reply')}</button>
    {/if}
    <button class="btn small" disabled={disabled || phase === 'running'} onclick={() => void start('fix')} onmouseenter={refresh} onfocus={refresh}>{t('ai.compose.fix')}</button>
    <button class="btn small" disabled={disabled || phase === 'running'} onclick={() => void start('formal')} onmouseenter={refresh} onfocus={refresh}>{t('ai.compose.formal')}</button>
    <button class="btn small" disabled={disabled || phase === 'running'} onclick={() => void start('friendly')} onmouseenter={refresh} onfocus={refresh}>{t('ai.compose.friendly')}</button>
    <button class="btn small" disabled={disabled || phase === 'running'} onclick={() => void start('shorter')} onmouseenter={refresh} onfocus={refresh}>{t('ai.compose.shorter')}</button>
    <span class="tr">
      <button class="btn small" disabled={disabled || phase === 'running'} onclick={() => void start('translate')} onmouseenter={refresh} onfocus={refresh}>{t('ai.compose.translate')}</button>
      <select bind:value={targetLang} aria-label={t('ai.compose.translateTo')} disabled={disabled || phase === 'running'}>
        {#each LANGS as l (l)}<option value={l}>{langName(l)}</option>{/each}
      </select>
    </span>
    <button class="x" aria-label={t('ai.compose.close')} title={t('ai.compose.close')} onclick={() => (cancel?.(), onclose())}>×</button>
  </div>
  <div class="row">
    <input
      class="instr"
      type="text"
      maxlength="1000"
      bind:value={instruction}
      placeholder={replyTo !== null ? t('ai.compose.instructionReply') : t('ai.compose.instruction')}
      aria-label={t('ai.compose.instructionLabel')}
      disabled={disabled || phase === 'running'}
      onkeydown={(e) => {
        if (e.key === 'Enter' && instruction.trim()) {
          e.preventDefault()
          void start(replyTo !== null && !preview?.selection ? 'reply' : 'custom')
        }
      }}
    />
    <button class="btn small" disabled={disabled || phase === 'running' || !instruction.trim()} onclick={() => void start('custom')} onmouseenter={refresh} onfocus={refresh}>{t('ai.compose.custom')}</button>
  </div>
  <p class="note">
    {t('ai.compose.sends', { scope: scopeText, target: aiTarget(ai.config) })}{#if replyTo !== null}&nbsp;{t('ai.compose.sendsReply')}{/if}
  </p>

  {#if phase === 'running' || phase === 'done'}
    <div class="result" aria-live="polite">
      <pre>{output || '…'}</pre>
      {#if phase === 'running'}
        <div class="acts"><span class="muted">{t('ai.working')}</span><button class="btn small" onclick={() => cancel?.()}>{t('ai.stop')}</button></div>
      {:else}
        {#if truncated}<p class="warn">{t('ai.truncated')}</p>{/if}
        {#if notApplied}<p class="warn" role="alert">{t('ai.compose.changed')}</p>{/if}
        <div class="acts">
          <button class="btn small btn-primary" disabled={disabled} onclick={insert}>
            {action === 'reply' || !source?.text.trim() ? t('ai.compose.insert') : source?.selection ? t('ai.compose.replaceSelection') : t('ai.compose.replace')}
          </button>
          <button class="btn small" onclick={() => action && void start(action)}>{t('ai.again')}</button>
          <button class="btn small" onclick={discard}>{t('ai.compose.discard')}</button>
          <span class="muted">{t('ai.mayErr')}</span>
        </div>
      {/if}
    </div>
  {:else if phase === 'error'}
    <p class="error" role="alert">{error}</p>
  {/if}
</section>

<style>
  .ai {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.5rem 1rem 0.55rem;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
    max-height: 45vh;
    overflow: auto;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
  }
  .btn.small {
    padding: 0.2em 0.65em;
    font-size: 0.82rem;
  }
  .tr {
    display: inline-flex;
    gap: 0.2rem;
  }
  select,
  .instr {
    padding: 0.25em 0.45em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-size: 0.85rem;
  }
  .instr {
    flex: 1;
    min-width: 12rem;
  }
  .x {
    margin-inline-start: auto;
    border: 0;
    background: none;
    font-size: 1.2rem;
    line-height: 1;
    cursor: pointer;
    color: var(--text-muted);
  }
  .note,
  .muted {
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .result {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    padding: 0.5rem 0.7rem;
  }
  pre {
    margin: 0 0 0.4rem;
    white-space: pre-wrap;
    font: 14px/1.5 var(--font-ui);
    max-height: 22vh;
    overflow: auto;
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .warn {
    margin: 0 0 0.3rem;
    font-size: 0.8rem;
    color: var(--warning);
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 0.85rem;
  }
</style>
