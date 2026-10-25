<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import { t } from '../i18n/index.svelte'
  import { ai, aiErrorText, aiTarget, aiUi, runAi, summaries } from '../lib/ai.svelte'

  /** Zhrnutie správy pomocou AI – len na pokyn; pred odoslaním (ak to používateľ nevypol) povie, čo a kam ide. */
  let { messageId }: { messageId: number } = $props()

  const cached = untrack(() => summaries.get(messageId))
  let phase = $state<'confirm' | 'running' | 'done' | 'error'>(cached ? 'done' : ai.config?.confirm === false ? 'running' : 'confirm')
  let text = $state(cached?.text ?? '')
  let target = $state(cached?.target ?? aiTarget())
  let truncated = $state(cached?.truncated ?? false)
  let error = $state<string | null>(null)
  let dontAsk = $state(false)
  let cancel: (() => void) | null = null

  async function start(): Promise<void> {
    if (dontAsk && ai.config) ai.config = await window.doar.invoke('ai.config.set', { confirm: false }).catch(() => ai.config)
    phase = 'running'
    text = ''
    error = null
    target = aiTarget()
    const job = runAi({ task: 'summary', messageId }, (soFar) => (text = soFar))
    cancel = job.cancel
    try {
      const r = await job.result
      text = r.text
      truncated = r.truncated
      summaries.set(messageId, { text, target, truncated })
      phase = 'done'
    } catch (e) {
      if ((e as { code?: string }).code === 'AI_CANCELLED') close()
      else {
        phase = 'error'
        error = aiErrorText(e)
      }
    } finally {
      cancel = null
    }
  }

  function close(): void {
    cancel?.()
    if (aiUi.summaryFor === messageId) aiUi.summaryFor = null
  }

  onMount(() => {
    if (phase === 'running') void start()
  })
  onDestroy(() => cancel?.())
</script>

<section class="sum" aria-label={t('ai.summary.title')} aria-live="polite">
  {#if phase === 'confirm'}
    <p>✨ {t('ai.summary.confirm', { target: aiTarget() })}</p>
    <div class="acts">
      <button class="btn small btn-primary" onclick={() => void start()}>{t('ai.summary.send')}</button>
      <button class="btn small" onclick={close}>{t('ai.cancel')}</button>
      <label class="check"><input type="checkbox" bind:checked={dontAsk} /> {t('ai.summary.dontAsk')}</label>
    </div>
  {:else}
    <div class="head">
      <strong>✨ {t('ai.summary.title')}</strong>
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
