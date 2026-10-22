<script lang="ts">
  import type { FolderItem } from '../../../shared/ipc'
  import { t } from '../i18n/index.svelte'
  import { mail, selectFolder } from '../lib/mail.svelte'
  import { backup } from '../lib/backup.svelte'
  import { ui, moveTo, openMenu, folderLabel } from '../lib/actions.svelte'
  import { openSettings } from '../lib/settings.svelte'

  let { onAddAccount }: { onAddAccount: () => void } = $props()

  const unifiedUnread = $derived(mail.folders.filter((f) => f.specialUse === 'inbox').reduce((s, f) => s + f.unread, 0))

  const label = folderLabel
  let dropTarget = $state<number | null>(null)

  /** Dajú sa ťahané správy pustiť na tento priečinok? (len v rámci konta, nie do toho istého priečinka) */
  function canDrop(f: FolderItem): boolean {
    const d = ui.dragging
    if (!d || !f.selectable) return false
    if (d.accountIds.length !== 1 || d.accountIds[0] !== f.accountId) return false
    return !(d.ids.length && mail.folderId === f.id)
  }

  function onDragOver(e: DragEvent, f: FolderItem): void {
    if (!canDrop(f)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropTarget = f.id
  }

  function onDrop(e: DragEvent, f: FolderItem): void {
    const d = ui.dragging
    dropTarget = null
    if (!d || !canDrop(f)) return
    e.preventDefault()
    ui.dragging = null
    void moveTo(d.ids, { folderId: f.id })
  }

  function newFolder(accountId: number, parentId: number | null): void {
    ui.newFolder = { accountId, parentId }
  }

  function folderMenu(e: MouseEvent, f: FolderItem): void {
    e.preventDefault()
    openMenu(e.clientX, e.clientY, [{ label: t('actions.newSubfolder'), run: () => newFolder(f.accountId, f.id) }], label(f))
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
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <h2
        oncontextmenu={(e) => {
          e.preventDefault()
          openMenu(e.clientX, e.clientY, [
            { label: t('actions.newFolder'), run: () => newFolder(acc.id, null) },
            { label: t('folders.accountSettings'), run: () => openSettings({ accountId: acc.id }) }
          ], acc.email)
        }}
      >
        <span class="dot" style:background={acc.color} aria-hidden="true"></span>
        <span class="acc-name" title={acc.email}>{!acc.name || acc.name === acc.email.split('@')[1] ? acc.email : acc.name}</span>
        <button class="new" title={t('folders.accountSettings')} aria-label={`${t('folders.accountSettings')} – ${acc.email}`} onclick={() => openSettings({ accountId: acc.id })}>⚙</button>
        <button class="new" title={t('actions.newFolder')} aria-label={`${t('actions.newFolder')} – ${acc.email}`} onclick={() => newFolder(acc.id, null)}>+</button>
      </h2>
      <ul class="tree">
        {#each foldersOf(acc.id) as f (f.id)}
          <li>
            <button
              class="item"
              class:active={mail.folderId === f.id}
              class:unread={f.unread > 0}
              class:drop={dropTarget === f.id}
              aria-current={mail.folderId === f.id ? 'page' : undefined}
              disabled={!f.selectable}
              style:padding-left={`${0.75 + f.depth * 0.9}rem`}
              onclick={() => selectFolder(f.id)}
              oncontextmenu={(e) => folderMenu(e, f)}
              ondragover={(e) => onDragOver(e, f)}
              ondragleave={() => dropTarget === f.id && (dropTarget = null)}
              ondrop={(e) => onDrop(e, f)}
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
  .acc-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .new {
    flex: none;
    border: 0;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.25rem;
    border-radius: var(--radius-sm);
    opacity: 0.6;
  }
  .account:hover .new,
  .new:focus-visible {
    opacity: 1;
  }
  .new:hover {
    color: var(--accent);
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .item.drop {
    background: var(--accent-soft);
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
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
