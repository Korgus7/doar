<script lang="ts">
  import { untrack } from 'svelte'
  import type { FolderItem, MailRule, MailRuleInput, RuleAction, RuleField } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { mail } from '../lib/mail.svelte'
  import { errorText, folderLabel } from '../lib/actions.svelte'
  import { settingsUi } from '../lib/settings.svelte'

  /**
   * Nastavenia → Pravidlá: čo urobiť s novou poštou v doručenej pošte (presunúť, prečítané, hviezdička…).
   * Pravidlá bežia v Doare – keď Doar nebeží, neuplatnia sa (pošta sa spracuje pri ďalšej synchronizácii).
   */
  const FIELDS: RuleField[] = ['from', 'to', 'subject', 'any']
  const ACTIONS: RuleAction[] = ['move', 'read', 'flag', 'archive', 'trash']

  let rules = $state<MailRule[]>([])
  let edit = $state<MailRuleInput | null>(null)
  let status = $state<{ ok: boolean; text: string } | null>(null)
  let busy = $state(false)

  async function load(): Promise<void> {
    rules = await window.doar.invoke('rules.list')
  }

  function blank(): MailRuleInput {
    return { name: '', enabled: true, accountId: null, field: 'from', value: '', action: 'move', folderId: null }
  }

  // „Vytvoriť pravidlo“ zo správy: predvyplnený formulár.
  $effect(() => {
    const draft = settingsUi.ruleDraft
    untrack(() => {
      void load()
      if (draft) {
        edit = { ...blank(), ...draft }
        settingsUi.ruleDraft = null
      }
    })
  })

  function accountFolders(accountId: number | null): FolderItem[] {
    return accountId === null ? [] : mail.folders.filter((f) => f.accountId === accountId && f.selectable)
  }

  function folderName(id: number | null): string {
    const f = mail.folders.find((x) => x.id === id)
    return f ? folderLabel(f) : '?'
  }

  function accountName(id: number | null): string {
    if (id === null) return t('rules.allAccounts')
    const a = mail.accounts.find((x) => x.id === id)
    return a ? a.email : '?'
  }

  function describe(r: MailRule): string {
    const what = t(`rules.field.${r.field}` as MessageKey)
    const action = r.action === 'move' ? t('rules.moveTo', { folder: folderName(r.folderId) }) : t(`rules.action.${r.action}` as MessageKey)
    return t('rules.summary', { field: what, value: r.value, action })
  }

  async function save(): Promise<void> {
    if (!edit) return
    busy = true
    status = null
    try {
      await window.doar.invoke('rules.save', $state.snapshot(edit))
      edit = null
      await load()
      status = { ok: true, text: t('rules.saved') }
    } catch (e) {
      status = { ok: false, text: errorText(e) }
    } finally {
      busy = false
    }
  }

  async function toggle(r: MailRule): Promise<void> {
    await window.doar.invoke('rules.save', { ...$state.snapshot(r), enabled: !r.enabled })
    await load()
  }

  async function remove(r: MailRule): Promise<void> {
    if (!confirm(t('rules.confirmDelete', { rule: describe(r) }))) return
    await window.doar.invoke('rules.delete', { id: r.id })
    await load()
  }

  async function move(i: number, dir: -1 | 1): Promise<void> {
    const ids = rules.map((r) => r.id)
    const j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    await window.doar.invoke('rules.reorder', { ids })
    await load()
  }

  /** Použiť pravidlo teraz na doručenú poštu (jeho konta, alebo všetkých kont). */
  async function runNow(r: MailRule): Promise<void> {
    busy = true
    status = null
    try {
      const inboxes = mail.folders.filter((f) => f.specialUse === 'inbox' && (r.accountId === null || f.accountId === r.accountId))
      let applied = 0
      for (const f of inboxes) applied += (await window.doar.invoke('rules.run', { folderId: f.id, ruleId: r.id })).applied
      status = { ok: true, text: t('rules.ranCount', { n: applied }) }
    } catch (e) {
      status = { ok: false, text: errorText(e) }
    } finally {
      busy = false
    }
  }
</script>

<div class="rules">
  <p class="note">{t('rules.intro')}</p>

  {#if edit}
    <form
      class="form"
      onsubmit={(ev) => {
        ev.preventDefault()
        void save()
      }}
    >
      <div class="row">
        <label class="stack">
          <span>{t('rules.when')}</span>
          <select bind:value={edit.field}>
            {#each FIELDS as f (f)}<option value={f}>{t(`rules.field.${f}` as MessageKey)}</option>{/each}
          </select>
        </label>
        <label class="stack grow">
          <span>{t('rules.contains')}</span>
          <input bind:value={edit.value} placeholder={t('rules.containsPlaceholder')} required />
        </label>
      </div>
      <div class="row">
        <label class="stack">
          <span>{t('rules.account')}</span>
          <select
            value={edit!.accountId === null ? '' : String(edit!.accountId)}
            onchange={(ev) => {
              edit!.accountId = ev.currentTarget.value ? Number(ev.currentTarget.value) : null
              edit!.folderId = null
            }}
          >
            <option value="">{t('rules.allAccounts')}</option>
            {#each mail.accounts as a (a.id)}<option value={String(a.id)}>{a.email}</option>{/each}
          </select>
        </label>
        <label class="stack">
          <span>{t('rules.then')}</span>
          <select bind:value={edit.action}>
            {#each ACTIONS as a (a)}<option value={a}>{t(`rules.action.${a}` as MessageKey)}</option>{/each}
          </select>
        </label>
        {#if edit!.action === 'move'}
          <label class="stack grow">
            <span>{t('rules.folder')}</span>
            {#if edit!.accountId === null}
              <small class="hint">{t('rules.pickAccount')}</small>
            {:else}
              <select value={edit!.folderId === null ? '' : String(edit!.folderId)} onchange={(ev) => (edit!.folderId = ev.currentTarget.value ? Number(ev.currentTarget.value) : null)} required>
                <option value="" disabled>—</option>
                {#each accountFolders(edit!.accountId) as f (f.id)}<option value={String(f.id)}>{' '.repeat(f.depth * 3)}{folderLabel(f)}</option>{/each}
              </select>
            {/if}
          </label>
        {/if}
      </div>
      <label class="stack">
        <span>{t('rules.name')}</span>
        <input bind:value={edit.name} placeholder={t('rules.namePlaceholder')} />
      </label>
      <div class="buttons">
        <button class="btn btn-primary" type="submit" disabled={busy || !edit!.value.trim() || (edit!.action === 'move' && edit!.folderId === null)}>{t('rules.save')}</button>
        <button class="btn" type="button" onclick={() => (edit = null)}>{t('rules.cancel')}</button>
      </div>
    </form>
  {:else}
    <div class="buttons">
      <button class="btn" onclick={() => (edit = blank())}>{t('rules.new')}</button>
    </div>
  {/if}

  {#if status}<p class="status" class:ok={status.ok} class:bad={!status.ok} role="status">{status.text}</p>{/if}

  {#if rules.length}
    <ul class="list" aria-label={t('rules.title')}>
      {#each rules as r, i (r.id)}
        <li class:off={!r.enabled}>
          <input type="checkbox" checked={r.enabled} aria-label={t('rules.enabled')} title={t('rules.enabled')} onchange={() => void toggle(r)} />
          <div class="text">
            <strong>{r.name || describe(r)}</strong>
            {#if r.name}<small>{describe(r)}</small>{/if}
            <small>{accountName(r.accountId)}</small>
          </div>
          <div class="tools">
            <button class="icon" title={t('rules.up')} aria-label={t('rules.up')} disabled={i === 0} onclick={() => void move(i, -1)}>↑</button>
            <button class="icon" title={t('rules.down')} aria-label={t('rules.down')} disabled={i === rules.length - 1} onclick={() => void move(i, 1)}>↓</button>
            <button class="btn small" disabled={busy} onclick={() => void runNow(r)}>{t('rules.runNow')}</button>
            <button class="btn small" onclick={() => (edit = { ...$state.snapshot(r) })}>{t('rules.edit')}</button>
            <button class="btn small danger" onclick={() => void remove(r)}>{t('rules.delete')}</button>
          </div>
        </li>
      {/each}
    </ul>
  {:else if !edit}
    <p class="empty">{t('rules.empty')}</p>
  {/if}
</div>

<style>
  .rules {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .note,
  small {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin: 0;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.9rem;
  }
  .grow {
    flex: 1;
    min-width: 12rem;
  }
  .hint {
    padding-top: 0.45rem;
  }
  input:not([type='checkbox']),
  select {
    padding: 0.4em 0.55em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  .buttons {
    display: flex;
    gap: 0.4rem;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.7rem;
  }
  .list li + li {
    border-top: 1px solid var(--border);
  }
  .list li.off .text {
    opacity: 0.55;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    overflow-wrap: anywhere;
  }
  .tools {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .icon {
    border: 1px solid transparent;
    background: none;
    border-radius: var(--radius-sm);
    width: 1.8rem;
    height: 1.8rem;
    cursor: pointer;
    color: var(--text-muted);
  }
  .icon:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .icon:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .btn.small {
    padding: 0.2em 0.6em;
    font-size: 0.82rem;
  }
  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .status {
    margin: 0;
    font-size: 0.85rem;
  }
  .status.ok {
    color: var(--ok);
  }
  .status.bad {
    color: var(--danger);
  }
</style>
