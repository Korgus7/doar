<script lang="ts">
  import { untrack } from 'svelte'
  import Icon from './Icon.svelte'
  import type { SearchFilters } from '../../../shared/ipc'
  import { t } from '../i18n/index.svelte'
  import { mail, runSearch, activeFilters } from '../lib/mail.svelte'

  /** Rozšírené hľadanie: od koho, komu, predmet, dátum od–do, len s prílohou, neprečítané, s hviezdičkou. */
  let { query }: { query: string } = $props()

  let open = $state(false)
  let form = $state<SearchFilters>({})
  let panel: HTMLDivElement | undefined = $state()
  let button: HTMLButtonElement | undefined = $state()
  const active = $derived(!!mail.search?.filters)

  function toggle(): void {
    if (!open) form = { ...(mail.search?.filters ?? {}) }
    open = !open
    if (open) setTimeout(() => panel?.querySelector<HTMLInputElement>('input')?.focus(), 0)
  }

  function apply(): void {
    open = false
    void runSearch(query, mail.search?.scope ?? 'all', activeFilters($state.snapshot(form)) ?? null)
  }

  function clear(): void {
    form = {}
    open = false
    void runSearch(query, mail.search?.scope ?? 'all', null)
  }

  // Zrušené hľadanie (iný priečinok, Escape v poli) zruší aj filtre.
  $effect(() => {
    if (!mail.search) untrack(() => (form = {}))
  })
</script>

<svelte:window
  onmousedown={(e) => {
    if (open && !panel?.contains(e.target as Node) && !button?.contains(e.target as Node)) open = false
  }}
/>

<button
  bind:this={button}
  type="button"
  class="filter"
  class:active
  aria-expanded={open}
  aria-label={t('search.advanced')}
  title={t('search.advanced')}
  onclick={toggle}><Icon name="filter" size={15} /></button
>
{#if open}
  <div
    class="panel"
    bind:this={panel}
    role="dialog"
    aria-label={t('search.advanced')}
    tabindex="-1"
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        open = false
        button?.focus()
      }
    }}
  >
    <form
      onsubmit={(e) => {
        e.preventDefault()
        apply()
      }}
    >
      <label><span>{t('search.f.from')}</span><input bind:value={form.from} placeholder={t('search.f.fromHint')} /></label>
      <label><span>{t('search.f.to')}</span><input bind:value={form.to} /></label>
      <label><span>{t('search.f.subject')}</span><input bind:value={form.subject} /></label>
      <div class="dates">
        <label><span>{t('search.f.after')}</span><input type="date" bind:value={form.after} /></label>
        <label><span>{t('search.f.before')}</span><input type="date" bind:value={form.before} /></label>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" bind:checked={form.attachment} /> {t('search.f.attachment')}</label>
        <label class="check"><input type="checkbox" bind:checked={form.unread} /> {t('search.f.unread')}</label>
        <label class="check"><input type="checkbox" bind:checked={form.flagged} /> {t('search.f.flagged')}</label>
      </div>
      <p class="tip">{t('search.f.tip')}</p>
      <div class="buttons">
        <button class="btn btn-primary" type="submit">{t('search.f.apply')}</button>
        <button class="btn" type="button" onclick={clear}>{t('search.f.clear')}</button>
      </div>
    </form>
  </div>
{/if}

<style>
  .filter {
    position: absolute;
    inset-inline-end: 0.3rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.7rem;
    height: 1.7rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }
  .filter:hover {
    background: var(--surface-2);
  }
  .filter.active {
    color: var(--accent);
    border-color: var(--accent);
  }
  .panel {
    position: absolute;
    top: calc(100% + 0.35rem);
    inset-inline-end: 0;
    z-index: 40;
    width: min(26rem, calc(100vw - 2rem));
    padding: 0.8rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }
  label > span {
    color: var(--text-muted);
  }
  input:not([type='checkbox']) {
    padding: 0.35em 0.5em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
  }
  .dates {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 1rem;
  }
  .check {
    flex-direction: row;
    align-items: center;
    gap: 0.35rem;
  }
  .tip {
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .buttons {
    display: flex;
    gap: 0.4rem;
  }
</style>
