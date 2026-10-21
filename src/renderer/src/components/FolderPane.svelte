<script lang="ts">
  import type { FolderItem } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { mail, selectFolder } from '../lib/mail.svelte'
  import { backup } from '../lib/backup.svelte'

  let { onAddAccount }: { onAddAccount: () => void } = $props()

  const unifiedUnread = $derived(mail.folders.filter((f) => f.specialUse === 'inbox').reduce((s, f) => s + f.unread, 0))

  function label(f: FolderItem): string {
    if (f.specialUse) return t(`folder.${f.specialUse}` as MessageKey)
    return f.name
  }

  function foldersOf(accountId: number): FolderItem[] {
    return mail.folders.filter((f) => f.accountId === accountId)
  }
</script>

<nav class="pane" aria-label={t('folders.label')}>
  <ul class="tree">
    <li>
      <button class="item unified" class:active={mail.folderId === null} aria-current={mail.folderId === null ? 'page' : undefined} onclick={() => selectFolder(null)}>
        <span class="icon" aria-hidden="true">★</span>
        <span class="name">{t('folders.unifiedInbox')}</span>
        {#if unifiedUnread}<span class="badge">{unifiedUnread}</span>{/if}
      </button>
    </li>
  </ul>

  {#each mail.accounts as acc (acc.id)}
    <section class="account">
      <h2><span class="dot" style:background={acc.color} aria-hidden="true"></span>{acc.email}</h2>
      <ul class="tree">
        {#each foldersOf(acc.id) as f (f.id)}
          <li>
            <button
              class="item"
              class:active={mail.folderId === f.id}
              class:unread={f.unread > 0}
              aria-current={mail.folderId === f.id ? 'page' : undefined}
              disabled={!f.selectable}
              style:padding-left={`${0.75 + f.depth * 0.9}rem`}
              onclick={() => selectFolder(f.id)}
            >
              <span class="name">{label(f)}</span>
              {#if f.unread && f.specialUse !== 'sent' && f.specialUse !== 'drafts' && f.specialUse !== 'trash'}
                <span class="badge">{f.unread}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  <button class="add" onclick={onAddAccount}>+ {t('menu.addAccount').replace('…', '')}</button>
  <button
    class="add"
    onclick={() => {
      backup.accountId = mail.folderId === null ? null : (mail.folders.find((f) => f.id === mail.folderId)?.accountId ?? null)
      backup.open = true
    }}>⤓ {t('menu.backup').replace('…', '')}</button
  >
</nav>

<style>
  .pane {
    height: 100%;
    overflow-y: auto;
    padding: 0.5rem 0.4rem 1rem;
    background: var(--surface-2);
  }
  .tree {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .account {
    margin-top: 0.9rem;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0 0 0.2rem;
    padding: 0 0.75rem;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    flex: 0 0 9px;
    height: 9px;
    border-radius: 50%;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.35rem 0.75rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .item:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .item.active {
    background: var(--accent-soft);
    color: var(--text);
    font-weight: 600;
  }
  .item:disabled {
    color: var(--text-muted);
    cursor: default;
  }
  .item.unread .name {
    font-weight: 600;
  }
  .unified {
    font-weight: 600;
  }
  .icon {
    color: var(--accent);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--accent);
  }
  .add {
    display: block;
    margin: 0.6rem 0.75rem 0;
    padding: 0.3rem 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.85rem;
  }
  .add:hover {
    color: var(--accent);
  }
</style>
