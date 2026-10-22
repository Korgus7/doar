<script lang="ts">
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { upd } from '../lib/update.svelte'
  import { fileSize } from '../lib/format'

  /** Pruh pod panelom nástrojov: nová verzia, priebeh sťahovania, reštart do novej verzie, chyba. */
  const s = $derived(upd.s)
  const visible = $derived(
    !!s &&
      ((s.phase === 'available' && upd.dismissed !== s.version) ||
        s.phase === 'downloading' ||
        s.phase === 'installing' ||
        s.phase === 'ready' ||
        (s.phase === 'error' && upd.dismissed !== `error:${s.error}`))
  )
  const pct = $derived(Math.round((s?.progress ?? 0) * 100))

  function errText(code: string | null): string {
    const key = `errors.${code ?? 'UNKNOWN'}` as MessageKey
    return t(key) !== key ? t(key) : t('errors.UNKNOWN')
  }
</script>

{#if visible && s}
  <div class="update" class:error={s.phase === 'error'} role="status" aria-live="polite">
    <span class="icon" aria-hidden="true">{s.phase === 'error' ? '⚠' : '⬆'}</span>
    <span class="text">
      {#if s.phase === 'available'}
        {t('update.available', { version: s.version ?? '' })}
      {:else if s.phase === 'downloading'}
        {t('update.downloading', { version: s.version ?? '', pct })}
      {:else if s.phase === 'installing'}
        {t('update.installing', { version: s.version ?? '', pct })}
      {:else if s.phase === 'ready'}
        {t('update.ready', { version: s.version ?? '' })}
      {:else}
        {t('update.failed', { reason: errText(s.error) })}
      {/if}
    </span>
    {#if s.phase === 'downloading' || s.phase === 'installing'}
      <progress max="1" value={s.progress} aria-label={t('update.downloading', { version: s.version ?? '', pct })}></progress>
    {/if}
    <span class="actions">
      {#if s.phase === 'available'}
        {#if s.notes || s.pageUrl}
          <button class="btn small" onclick={() => (s.notes ? (upd.showNotes = !upd.showNotes) : window.doar.updateOpenPage())}>{t('update.whatsNew')}</button>
        {/if}
        <button class="btn small btn-primary" disabled={!s.canInstall} title={s.canInstall ? '' : t('errors.UPDATE_DEV')} onclick={() => window.doar.updateDownload()}>
          {t('update.install', { size: fileSize(s.sizeBytes) })}
        </button>
        <button class="btn small" onclick={() => ((upd.dismissed = s.version), (upd.showNotes = false))}>{t('update.later')}</button>
      {:else if s.phase === 'downloading'}
        <button class="btn small" onclick={() => window.doar.updateCancel()}>{t('update.cancel')}</button>
      {:else if s.phase === 'ready'}
        <button class="btn small btn-primary" onclick={() => window.doar.updateRestart()}>{t('update.restart')}</button>
      {:else if s.phase === 'error'}
        <button class="btn small" onclick={() => window.doar.updateCheck()}>{t('update.retry')}</button>
        <button class="btn small" onclick={() => (upd.dismissed = `error:${s.error}`)}>{t('update.close')}</button>
      {/if}
    </span>
    {#if upd.showNotes && s.phase === 'available' && s.notes}
      <div class="notes">
        <pre>{s.notes}</pre>
        {#if s.pageUrl}<button class="link" onclick={() => window.doar.updateOpenPage()}>github.com</button>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .update {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.7rem;
    padding: 0.45rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
    font-size: 0.88rem;
  }
  .update.error {
    background: color-mix(in srgb, var(--warning) 16%, var(--surface));
  }
  .text {
    flex: 1;
    min-width: 12rem;
  }
  progress {
    width: 10rem;
    height: 6px;
    accent-color: var(--accent);
  }
  .actions {
    display: flex;
    gap: 0.4rem;
  }
  .btn.small {
    padding: 0.2em 0.65em;
    font-size: 0.82rem;
  }
  .notes {
    flex-basis: 100%;
    max-height: 12rem;
    overflow: auto;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  pre {
    margin: 0;
    white-space: pre-wrap;
    font: inherit;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0.3rem 0 0;
  }
</style>
