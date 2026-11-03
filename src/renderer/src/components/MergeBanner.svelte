<script lang="ts">
  import { onMount } from 'svelte'
  import type { MergeOffer } from '../../../shared/ipc'
  import { t } from '../i18n/index.svelte'
  import { showToast, errorText } from '../lib/actions.svelte'
  import { loadFolders } from '../lib/mail.svelte'

  /** Pruh: konto má priečinky iných programov (Trash, Sent Items…) – zlúčiť ich s hlavnými? Pýta sa raz za konto. */
  let offers = $state<MergeOffer[]>([])
  let busy = $state<number | null>(null)

  async function load(): Promise<void> {
    offers = await window.doar.invoke('folders.mergeOffers').catch(() => [])
  }

  onMount(() => {
    void load()
    return window.doar.on('folders.mergeOffer', () => {
      void load()
      void loadFolders().catch(() => {})
    })
  })

  async function answer(o: MergeOffer, merge: boolean): Promise<void> {
    busy = o.accountId
    try {
      if (merge) showToast(t('merge.running', { email: o.email }))
      const r = await window.doar.invoke('folders.mergeAnswer', { accountId: o.accountId, merge })
      await loadFolders().catch(() => {})
      if (merge) showToast(t('merge.done', { email: o.email, n: r.moved }) + (r.duplicates ? ' ' + t('merge.duplicates', { n: r.duplicates }) : ''))
    } catch (e) {
      showToast(errorText(e), { tone: 'error' })
    } finally {
      busy = null
      await load()
    }
  }
</script>

{#each offers as o (o.accountId)}
  <div class="merge" role="status" aria-live="polite">
    <span class="icon" aria-hidden="true">ℹ</span>
    <span class="text">{t('merge.offer', { email: o.email, folders: o.folders.map((f) => `„${f.name}“`).join(', ') })}</span>
    <span class="actions">
      <button class="btn small btn-primary" disabled={busy !== null} onclick={() => void answer(o, true)}>{t('merge.yes')}</button>
      <button class="btn small" disabled={busy !== null} onclick={() => void answer(o, false)}>{t('merge.no')}</button>
    </span>
  </div>
{/each}

<style>
  .merge {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.7rem;
    padding: 0.45rem 0.9rem;
    font-size: 0.88rem;
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    border-bottom: 1px solid var(--border);
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
</style>
