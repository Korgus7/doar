<script lang="ts">
  import { onMount } from 'svelte'
  import type { MailTemplate } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'

  /** Šablóny v okne správy: vložiť, uložiť aktuálnu správu ako šablónu, odstrániť. */
  let {
    current,
    apply,
    disabled = false,
    onclose
  }: {
    current: () => { subject: string; html: string | null; text: string }
    apply: (tpl: MailTemplate) => void
    disabled?: boolean
    onclose: () => void
  } = $props()

  let list = $state<MailTemplate[]>([])
  let name = $state('')
  let status = $state<{ ok: boolean; text: string } | null>(null)

  async function load(): Promise<void> {
    list = await window.doar.invoke('templates.list')
  }
  onMount(() => void load())

  function errText(e: unknown): string {
    const code = (e as { code?: string }).code
    const key = `errors.${code}` as MessageKey
    return t(key) !== key ? t(key) : t('errors.generic', { message: (e as { message?: string }).message ?? '' })
  }

  async function save(): Promise<void> {
    const n = name.trim()
    if (!n) return
    if (list.some((x) => x.name.toLowerCase() === n.toLowerCase()) && !confirm(t('templates.overwrite', { name: n }))) return
    try {
      await window.doar.invoke('templates.save', { name: n, ...current() })
      name = ''
      await load()
      status = { ok: true, text: t('templates.saved', { name: n }) }
    } catch (e) {
      status = { ok: false, text: errText(e) }
    }
  }

  async function remove(tpl: MailTemplate): Promise<void> {
    if (!confirm(t('templates.confirmDelete', { name: tpl.name }))) return
    await window.doar.invoke('templates.delete', { id: tpl.id })
    await load()
  }
</script>

<section class="panel" aria-label={t('templates.title')}>
  <div class="head">
    <strong>{t('templates.title')}</strong>
    <button class="x" type="button" aria-label={t('templates.close')} title={t('templates.close')} onclick={onclose}>×</button>
  </div>
  {#if list.length}
    <ul>
      {#each list as tpl (tpl.id)}
        <li>
          <button class="name" type="button" {disabled} title={t('templates.insertTitle')} onclick={() => apply(tpl)}>
            <span>{tpl.name}</span>
            {#if tpl.subject}<small>{tpl.subject}</small>{/if}
          </button>
          <button class="del" type="button" aria-label={t('templates.delete', { name: tpl.name })} title={t('templates.delete', { name: tpl.name })} onclick={() => void remove(tpl)}>×</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">{t('templates.empty')}</p>
  {/if}
  <form
    class="save"
    onsubmit={(e) => {
      e.preventDefault()
      void save()
    }}
  >
    <input bind:value={name} placeholder={t('templates.namePlaceholder')} aria-label={t('templates.name')} maxlength="200" {disabled} />
    <button class="btn" type="submit" disabled={disabled || !name.trim()}>{t('templates.saveCurrent')}</button>
  </form>
  {#if status}<p class="status" class:bad={!status.ok} role="status">{status.text}</p>{/if}
</section>

<style>
  .panel {
    border-bottom: 1px solid var(--border);
    padding: 0.5rem 1rem 0.6rem;
    background: var(--surface-2);
    font-size: 0.88rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.35rem;
  }
  .x,
  .del {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1.1rem;
    line-height: 1;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
  }
  .x:hover,
  .del:hover {
    background: var(--surface);
  }
  ul {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    max-height: 7.5rem;
    overflow: auto;
  }
  li {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .name {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    border: 0;
    background: none;
    cursor: pointer;
    padding: 0.25rem 0.6rem;
    max-width: 16rem;
    text-align: start;
    color: var(--text);
  }
  .name:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .name span,
  .name small {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small,
  .empty {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .empty {
    margin: 0 0 0.5rem;
  }
  .save {
    display: flex;
    gap: 0.4rem;
  }
  .save input {
    flex: 1;
    min-width: 0;
    padding: 0.35em 0.55em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  .status {
    margin: 0.4rem 0 0;
    font-size: 0.82rem;
    color: var(--ok);
  }
  .status.bad {
    color: var(--danger);
  }
</style>
