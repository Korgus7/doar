<script lang="ts">
  import { tick } from 'svelte'
  import { t } from '../i18n/index.svelte'
  import { fileSize } from '../lib/format'
  import { ui, openAttachment, saveAttachment } from '../lib/actions.svelte'

  /** Náhľad prílohy (obrázok, text) nad oknom. Escape alebo klik vedľa zavrie. */
  let dialogEl: HTMLDivElement | undefined = $state()
  let zoom = $state(false)

  $effect(() => {
    if (ui.preview) {
      zoom = false
      void tick().then(() => dialogEl?.focus())
    }
  })

  function close(): void {
    ui.preview = null
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (ui.preview && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }}
/>

{#if ui.preview}
  {@const p = ui.preview}
  <div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
    <div class="dialog" bind:this={dialogEl} role="dialog" aria-modal="true" aria-label={t('attachments.previewOf', { name: p.attachment.filename })} tabindex="-1">
      <header>
        <strong class="name" title={p.attachment.filename}>{p.attachment.filename}</strong>
        <span class="size">{fileSize(p.attachment.size)}</span>
        <span class="tools">
          {#if p.image}
            <button class="btn small" aria-pressed={zoom} onclick={() => (zoom = !zoom)}>{zoom ? t('attachments.fit') : t('attachments.actualSize')}</button>
          {/if}
          <button class="btn small" onclick={() => void openAttachment(p.messageId, p.attachment)}>{t('attachments.open')}</button>
          <button class="btn small" onclick={() => void saveAttachment(p.messageId, p.attachment)}>{t('attachments.saveAs')}</button>
          <button class="x" aria-label={t('backup.close')} title={t('backup.close')} onclick={close}>×</button>
        </span>
      </header>
      <div class="body" class:zoom>
        {#if p.image}
          <img src={p.image} alt={p.attachment.filename} />
        {:else}
          <pre dir="auto">{p.text}</pre>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 1.5rem;
    background: rgb(0 0 0 / 55%);
  }
  .dialog {
    display: flex;
    flex-direction: column;
    max-width: min(1200px, 100%);
    max-height: 100%;
    min-width: min(420px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 12px 40px rgb(0 0 0 / 35%);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.6rem 0.5rem 0.9rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.88rem;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    color: var(--text-muted);
    flex: none;
  }
  .tools {
    margin-inline-start: auto;
    display: flex;
    gap: 0.35rem;
    align-items: center;
    flex: none;
  }
  .btn.small {
    padding: 0.2em 0.6em;
    font-size: 0.82rem;
  }
  .x {
    border: 0;
    background: none;
    font-size: 1.3rem;
    line-height: 1;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
  }
  .x:hover {
    background: var(--surface-2);
  }
  .body {
    min-height: 0;
    overflow: auto;
    display: grid;
    place-items: center;
    background: var(--surface-2);
  }
  .body img {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 7rem);
    object-fit: contain;
  }
  .body.zoom {
    place-items: start;
  }
  .body.zoom img {
    max-width: none;
    max-height: none;
  }
  pre {
    margin: 0;
    padding: 0.9rem 1rem;
    width: min(900px, calc(100vw - 4rem));
    max-height: calc(100vh - 7rem);
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    unicode-bidi: plaintext;
    font: 0.85rem/1.5 ui-monospace, 'Cascadia Mono', Consolas, monospace;
    background: var(--surface);
    place-self: stretch;
  }
</style>
