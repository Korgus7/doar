<script lang="ts">
  import { tick } from 'svelte'
  import { t } from '../i18n/index.svelte'
  import { mail } from '../lib/mail.svelte'
  import { ui, createFolder, errorText, folderLabel } from '../lib/actions.svelte'

  let el: HTMLDivElement | undefined = $state()
  let name = $state('')
  let parentId = $state<number | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)

  const account = $derived(mail.accounts.find((a) => a.id === ui.newFolder?.accountId))
  const parents = $derived(mail.folders.filter((f) => f.accountId === ui.newFolder?.accountId))

  $effect(() => {
    const d = ui.newFolder
    if (!d) return
    name = ''
    error = null
    busy = false
    parentId = d.parentId
    void tick().then(() => el?.querySelector<HTMLInputElement>('input')?.focus())
  })

  function close(): void {
    ui.newFolder = null
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault()
    const d = ui.newFolder
    if (!d || busy) return
    if (!name.trim()) {
      error = t('errors.INVALID_FOLDER_NAME')
      return
    }
    busy = true
    error = null
    try {
      await createFolder(d.accountId, parentId, name)
      close()
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }
</script>

{#if ui.newFolder}
  <div class="overlay" role="presentation">
    <div
      class="dialog"
      bind:this={el}
      role="dialog"
      aria-modal="true"
      aria-labelledby="nf-title"
      tabindex="-1"
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      <h1 id="nf-title">{t('folderDialog.titleNew')}</h1>
      <p class="sub">{account?.email}</p>
      <form onsubmit={submit}>
        <label class="field">
          <span>{t('folderDialog.name')}</span>
          <input bind:value={name} maxlength="200" aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'nf-error' : undefined} />
        </label>
        <label class="field">
          <span>{t('folderDialog.parent')}</span>
          <select bind:value={parentId}>
            <option value={null}>{t('folderDialog.topLevel')}</option>
            {#each parents as f (f.id)}
              <option value={f.id}>{'  '.repeat(f.depth)}{folderLabel(f)}</option>
            {/each}
          </select>
        </label>
        {#if error}<p class="alert error" id="nf-error" role="alert">{error}</p>{/if}
        <div class="actions">
          <span class="spacer"></span>
          <button type="button" class="btn" onclick={close}>{t('wizard.cancel')}</button>
          <button type="submit" class="btn btn-primary" disabled={busy}>{t('folderDialog.create')}</button>
        </div>
      </form>
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
    z-index: 55;
  }
  .dialog {
    width: min(420px, 100%);
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
    margin: 0.2rem 0 0.9rem;
    color: var(--text-muted);
    font-size: 0.88rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.8rem;
  }
  input,
  select {
    padding: 0.45em 0.6em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
  }
  .alert.error {
    margin: 0 0 0.6rem;
    color: var(--danger);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.4rem;
  }
  .spacer {
    flex: 1;
  }
</style>
