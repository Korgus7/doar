<script lang="ts">
  import { tick } from 'svelte'
  import { t } from '../i18n/index.svelte'
  import { mail, itemsById } from '../lib/mail.svelte'
  import { ui, moveTo, folderLabel } from '../lib/actions.svelte'

  let el: HTMLDivElement | undefined = $state()
  let chosen = $state<number | null>(null)
  let filter = $state('')

  const account = $derived(mail.accounts.find((a) => a.id === ui.moveDialog?.accountId))
  /** Priečinky, v ktorých sú vybrané správy – tam presun nedáva zmysel. */
  const sources = $derived(new Set(ui.moveDialog ? itemsById(ui.moveDialog.ids).map((m) => m.folderId) : []))
  const folders = $derived(
    mail.folders.filter((f) => f.accountId === ui.moveDialog?.accountId && (!filter.trim() || folderLabel(f).toLowerCase().includes(filter.trim().toLowerCase())))
  )

  $effect(() => {
    if (!ui.moveDialog) return
    chosen = null
    filter = ''
    void tick().then(() => el?.querySelector<HTMLInputElement>('input')?.focus())
  })

  // Priečinok založený priamo z tohto dialógu sa rovno vyberie.
  $effect(() => {
    const id = ui.createdFolderId
    if (id !== null && ui.moveDialog) chosen = id
  })

  function close(): void {
    ui.moveDialog = null
  }

  function confirmMove(id = chosen): void {
    const d = ui.moveDialog
    if (!d || id === null) return
    close()
    void moveTo(d.ids, { folderId: id })
  }

  function newFolder(): void {
    const d = ui.moveDialog
    if (!d) return
    ui.newFolder = { accountId: d.accountId, parentId: null }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !ui.newFolder) {
      e.preventDefault()
      close()
    }
  }

  function onListKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const usable = folders.filter((f) => f.selectable && !sources.has(f.id))
    const i = usable.findIndex((f) => f.id === chosen)
    const next = usable[Math.max(0, Math.min(usable.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      chosen = next.id
      el?.querySelector<HTMLElement>(`[data-folder="${next.id}"]`)?.focus()
    }
  }
</script>

{#if ui.moveDialog}
  <div class="overlay" role="presentation">
    <div class="dialog" bind:this={el} role="dialog" aria-modal="true" aria-labelledby="move-title" tabindex="-1" onkeydown={onKey}>
      <h1 id="move-title">{t('folderDialog.titleMove')}</h1>
      <p class="sub">{account?.email} · {ui.moveDialog.ids.length === 1 ? t('folderDialog.oneMessage') : t('reader.multi', { n: ui.moveDialog.ids.length })}</p>
      <input
        type="search"
        placeholder={t('folderDialog.filter')}
        aria-label={t('folderDialog.filter')}
        bind:value={filter}
        onkeydown={(e) => {
          if (e.key === 'ArrowDown') onListKey(e)
          else if (e.key === 'Enter') confirmMove(chosen ?? folders.find((f) => f.selectable && !sources.has(f.id))?.id ?? null)
        }}
      />
      <div class="list" role="listbox" tabindex="-1" aria-label={t('folders.label')} onkeydown={onListKey}>
        {#each folders as f (f.id)}
          {@const usable = f.selectable && !sources.has(f.id)}
          <div
            class="opt"
            class:chosen={chosen === f.id}
            class:muted={!usable}
            role="option"
            aria-selected={chosen === f.id}
            aria-disabled={!usable}
            tabindex={usable ? 0 : -1}
            data-folder={f.id}
            style:padding-left={`${0.6 + (filter.trim() ? 0 : f.depth) * 0.9}rem`}
            onclick={() => usable && (chosen = f.id)}
            ondblclick={() => usable && confirmMove(f.id)}
            onkeydown={(e) => {
              if (e.key === 'Enter' && usable) confirmMove(f.id)
              else if (e.key === ' ' && usable) {
                e.preventDefault()
                chosen = f.id
              }
            }}
          >
            {folderLabel(f)}
          </div>
        {/each}
      </div>
      <div class="actions">
        <button class="btn" onclick={newFolder}>+ {t('actions.newFolder')}</button>
        <span class="spacer"></span>
        <button class="btn" onclick={close}>{t('wizard.cancel')}</button>
        <button class="btn btn-primary" disabled={chosen === null} onclick={() => confirmMove()}>{t('folderDialog.move')}</button>
      </div>
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
    width: min(440px, 100%);
    max-height: calc(100vh - 2rem);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 1.3rem 1.4rem 1.1rem;
    box-shadow: 0 12px 40px rgb(0 0 0 / 25%);
  }
  h1 {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 650;
  }
  .sub {
    margin: 0.2rem 0 0.8rem;
    color: var(--text-muted);
    font-size: 0.88rem;
  }
  input {
    padding: 0.45em 0.6em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    margin-bottom: 0.5rem;
  }
  .list {
    flex: 1;
    min-height: 160px;
    max-height: 360px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.25rem;
  }
  .opt {
    padding: 0.3rem 0.6rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .opt:hover:not(.muted) {
    background: color-mix(in srgb, var(--text) 6%, transparent);
  }
  .opt.chosen {
    background: var(--accent-soft);
    font-weight: 600;
  }
  .opt.muted {
    color: var(--text-muted);
    cursor: default;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .spacer {
    flex: 1;
  }
</style>
