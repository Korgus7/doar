<script lang="ts">
  import type { Signature } from '../../../shared/ipc'
  import { t } from '../i18n/index.svelte'
  import { mail, loadAccounts } from '../lib/mail.svelte'
  import { errorText } from '../lib/actions.svelte'
  import RichEditor from './RichEditor.svelte'

  /** Nastavenia konta → Podpisy: viac podpisov, formátovanie, logo, predvolený pre nové správy. */
  let { accountId }: { accountId: number } = $props()

  const list = $derived(mail.accounts.find((a) => a.id === accountId)?.signatures ?? [])
  let edit = $state<{ id?: number; name: string; html: string } | null>(null)
  let editorRef: RichEditor | undefined = $state()
  let status = $state<{ ok: boolean; text: string } | null>(null)
  let busy = $state(false)

  const sigName = (x: Signature, i: number): string => x.name || t('signature.numbered', { n: i + 1 })

  async function run(fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
    busy = true
    status = null
    try {
      await fn()
      await loadAccounts()
      if (ok) status = { ok: true, text: ok }
      return true
    } catch (e) {
      status = { ok: false, text: errorText(e) }
      return false
    } finally {
      busy = false
    }
  }

  async function save(): Promise<void> {
    if (!edit) return
    const html = editorRef?.getHTML() ?? edit.html
    const input = { ...(edit.id ? { id: edit.id } : {}), accountId, name: edit.name, html }
    if (await run(() => window.doar.invoke('signatures.save', input), t('signature.saved'))) edit = null
  }

  async function remove(x: Signature, i: number): Promise<void> {
    if (!confirm(t('signature.confirmDelete', { name: sigName(x, i) }))) return
    await run(() => window.doar.invoke('signatures.delete', { id: x.id }))
  }

  /** Logo: obrázok zo súboru (do 500 kB), široký sa zobrazí zmenšený na 240 px. */
  async function insertLogo(): Promise<void> {
    const files = await window.doar.chooseAttachFiles()
    const f = files[0]
    if (!f) return
    try {
      const { dataUrl } = await window.doar.invoke('signatures.readImage', { path: f.path })
      const width = await new Promise<number | undefined>((resolve) => {
        const img = new Image()
        img.onload = () => resolve(img.naturalWidth > 240 ? 240 : undefined)
        img.onerror = () => resolve(undefined)
        img.src = dataUrl
      })
      editorRef?.insertImage(dataUrl, width)
    } catch (e) {
      status = { ok: false, text: errorText(e) }
    }
  }
</script>

<fieldset class="sigs">
  <legend>{t('signature.title')}</legend>
  {#if list.length}
    <ul>
      {#each list as x, i (x.id)}
        <li>
          <label class="default" title={t('signature.defaultHint')}>
            <input
              type="radio"
              name={`sig-default-${accountId}`}
              checked={x.isDefault}
              onchange={() => void run(() => window.doar.invoke('signatures.setDefault', { accountId, id: x.id }))}
            />
            <span>{sigName(x, i)}</span>
          </label>
          <span class="preview">{x.text.split('\n').filter(Boolean).slice(0, 2).join(' · ')}</span>
          <button class="btn small" type="button" disabled={busy || !!edit} onclick={() => (edit = { id: x.id, name: x.name, html: x.html })}>{t('signature.edit')}</button>
          <button class="btn small danger" type="button" disabled={busy} onclick={() => void remove(x, i)}>{t('signature.delete')}</button>
        </li>
      {/each}
      <li>
        <label class="default">
          <input
            type="radio"
            name={`sig-default-${accountId}`}
            checked={!list.some((x) => x.isDefault)}
            onchange={() => void run(() => window.doar.invoke('signatures.setDefault', { accountId, id: null }))}
          />
          <span>{t('signature.noneDefault')}</span>
        </label>
      </li>
    </ul>
  {:else if !edit}
    <p class="hint">{t('signature.empty')}</p>
  {/if}

  {#if edit}
    <div class="editor">
      <label class="name">
        <span>{t('signature.name')}</span>
        <input bind:value={edit.name} maxlength="100" placeholder={t('signature.namePlaceholder')} />
      </label>
      {#key edit.id ?? 'new'}
        <RichEditor bind:this={editorRef} html={edit.html} label={t('signature.text')} onchange={(h) => edit && (edit.html = h)} />
      {/key}
      <div class="buttons">
        <button class="btn btn-primary" type="button" disabled={busy} onclick={() => void save()}>{t('signature.save')}</button>
        <button class="btn" type="button" disabled={busy} onclick={() => void insertLogo()}>{t('signature.logo')}</button>
        <button class="btn" type="button" onclick={() => (edit = null)}>{t('signature.cancel')}</button>
      </div>
    </div>
  {:else}
    <div class="buttons">
      <button class="btn" type="button" onclick={() => (edit = { name: '', html: '' })}>{t('signature.new')}</button>
    </div>
  {/if}
  {#if status}<p class="status" class:bad={!status.ok} role="status">{status.text}</p>{/if}
</fieldset>

<style>
  .sigs {
    border: 0;
    padding: 0;
    margin: 1.2rem 0 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  legend {
    font-weight: 600;
    font-size: 0.9rem;
    padding: 0;
    margin-bottom: 0.25rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
  }
  li + li {
    border-top: 1px solid var(--border);
  }
  .default {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: none;
    font-size: 0.9rem;
  }
  .preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.82rem;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .editor :global(.doar-editor) {
    min-height: 7rem;
    background: var(--bg);
  }
  .name {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.88rem;
  }
  .name input {
    padding: 0.35em 0.5em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  .buttons {
    display: flex;
    gap: 0.4rem;
  }
  .btn.small {
    padding: 0.2em 0.6em;
    font-size: 0.82rem;
  }
  .hint {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .status {
    margin: 0;
    font-size: 0.85rem;
    color: var(--ok);
  }
  .status.bad {
    color: var(--danger);
  }
</style>
