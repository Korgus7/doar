<script lang="ts">
  import { onMount } from 'svelte'
  import type { OutboxItem } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'

  let items = $state<OutboxItem[]>([])

  async function load(): Promise<void> {
    items = await window.doar.invoke('outbox.list')
  }

  onMount(() => {
    void load()
    return window.doar.on('outbox.changed', () => void load())
  })

  function reason(code: string | null): string {
    const key = `errors.${code ?? 'UNKNOWN'}` as MessageKey
    return t(key) !== key ? t(key) : t('errors.UNKNOWN')
  }

  const subj = (i: OutboxItem): string => i.subject || t('outbox.noSubject')

  async function resolve(id: number, action: 'resend' | 'discard'): Promise<void> {
    await window.doar.invoke('outbox.resolve', { id, action })
  }

  // Zobrazujeme len to, čo potrebuje pozornosť alebo práve prebieha.
  const visible = $derived(items.filter((i) => i.state !== 'sent' || i.sentCopyState === 'failed'))
</script>

{#if visible.length}
  <section class="outbox" aria-label={t('outbox.label')} aria-live="polite">
    {#each visible as i (i.id)}
      <div class="item {i.state}" role={i.state === 'uncertain' || i.state === 'error' ? 'alert' : undefined}>
        {#if i.state === 'queued' && i.error === 'OFFLINE'}
          <span class="icon" aria-hidden="true">⏸</span>
          <span class="text">{t('outbox.waitingNetwork', { subject: subj(i) })}</span>
          <span class="actions">
            <button class="btn small" onclick={() => confirm(t('outbox.cancelConfirm', { subject: subj(i) })) && resolve(i.id, 'discard')}>{t('outbox.dontSend')}</button>
          </span>
        {:else if i.state === 'queued' || i.state === 'sending'}
          <span class="spin" aria-hidden="true">⟳</span>
          <span class="text">{t('outbox.sending', { subject: subj(i) })}</span>
        {:else if i.state === 'uncertain'}
          <span class="icon" aria-hidden="true">⚠</span>
          <span class="text">{t('outbox.uncertain', { subject: subj(i) })}</span>
          <span class="actions">
            <!-- Predvolená (prvá, zvýraznená) voľba je bezpečná: neodosielať znova. -->
            <button class="btn btn-primary small" onclick={() => resolve(i.id, 'discard')}>{t('outbox.dontSend')}</button>
            <button class="btn small" onclick={() => resolve(i.id, 'resend')}>{t('outbox.resend')}</button>
          </span>
        {:else if i.state === 'error'}
          <span class="icon" aria-hidden="true">✕</span>
          <span class="text">{t('outbox.error', { subject: subj(i), reason: reason(i.error) })}</span>
          <span class="actions">
            <button class="btn small" onclick={() => resolve(i.id, 'resend')}>{t('outbox.resend')}</button>
            <button class="btn small" onclick={() => resolve(i.id, 'discard')}>{t('outbox.discard')}</button>
          </span>
        {:else if i.sentCopyState === 'failed'}
          <span class="icon" aria-hidden="true">ℹ</span>
          <span class="text">{t('outbox.copyFailed', { subject: subj(i) })}</span>
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .outbox {
    display: grid;
    gap: 1px;
    background: var(--border);
    border-bottom: 1px solid var(--border);
  }
  .item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.7rem;
    padding: 0.45rem 0.9rem;
    font-size: 0.88rem;
    background: var(--surface);
  }
  .item.uncertain {
    background: color-mix(in srgb, var(--warning) 14%, var(--surface));
  }
  .item.error {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  }
  .text {
    flex: 1 1 320px;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
  }
  .btn.small {
    padding: 0.2em 0.7em;
    font-size: 0.82rem;
  }
  .spin {
    display: inline-block;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
</style>
