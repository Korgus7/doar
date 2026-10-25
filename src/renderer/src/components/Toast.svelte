<script lang="ts">
  import { t } from '../i18n/index.svelte'
  import { ui, undoLast, hideToast } from '../lib/actions.svelte'
</script>

<div class="wrap" role="status" aria-live="polite">
  {#if ui.toast}
    <div class="toast" class:error={ui.toast.tone === 'error'}>
      <span class="text">{ui.toast.text}</span>
      {#if ui.toast.undo}
        <button class="undo" title="Ctrl+Z" onclick={() => void undoLast()}>{t('actions.undo')}</button>
      {/if}
      <button class="close" aria-label={t('backup.close')} title={t('backup.close')} onclick={hideToast}>×</button>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: fixed;
    left: 50%;
    bottom: 2.6rem;
    transform: translateX(-50%);
    z-index: 45;
    max-width: calc(100vw - 2rem);
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    padding-block: 0.55rem;
    padding-inline: 1rem 0.6rem;
    border-radius: var(--radius);
    background: #2b3038;
    color: #f2f4f7;
    box-shadow: 0 6px 24px rgb(0 0 0 / 28%);
    font-size: 0.9rem;
  }
  .toast.error {
    background: #7a1d1d;
  }
  .text {
    overflow-wrap: anywhere;
  }
  .undo {
    border: 0;
    background: none;
    color: #9ec0ff;
    font-weight: 650;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    white-space: nowrap;
  }
  .undo:hover {
    text-decoration: underline;
  }
  .close {
    border: 0;
    background: none;
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0.1rem 0.35rem;
  }
  .close:hover {
    opacity: 1;
  }
</style>
