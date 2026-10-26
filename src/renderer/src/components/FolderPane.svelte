<script lang="ts">
  import type { FolderItem } from '../../../shared/ipc'
  import { t } from '../i18n/index.svelte'
  import { mail, selectFolder } from '../lib/mail.svelte'
  import { closeArchive, archivePercent } from '../lib/archive.svelte'
  import type { MessageKey } from '../i18n/index.svelte'
  import { ui, moveTo, openMenu, folderLabel } from '../lib/actions.svelte'
  import { openSettings } from '../lib/settings.svelte'
  import Icon, { type IconName } from './Icon.svelte'
  import type { SpecialUse } from '../../../shared/ipc'

  const ICON_OF: Record<SpecialUse, IconName> = {
    inbox: 'inbox',
    drafts: 'drafts',
    sent: 'sent',
    archive: 'archive',
    junk: 'spam',
    trash: 'trash',
    all: 'inboxes',
    flagged: 'star',
    important: 'star'
  }

  // Zbalené kontá (a archívy so záporným id) – pamätá sa v tomto počítači.
  const COLLAPSED_KEY = 'doar.collapsed'
  let collapsed = $state<number[]>(loadCollapsed())
  function loadCollapsed(): number[] {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown
      return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []
    } catch {
      return []
    }
  }
  function toggle(id: number): void {
    collapsed = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
    } catch {
      /* nezapamätá sa */
    }
  }
  function inboxUnread(accountId: number): number {
    return mail.folders.filter((f) => f.accountId === accountId && f.specialUse === 'inbox').reduce((s, f) => s + f.unread, 0)
  }

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
        <span class="icon"><Icon name="inboxes" /></span>
        <span class="name">{t('folders.unifiedInbox')}</span>
        {#if unifiedUnread}<span class="badge">{unifiedUnread}</span>{/if}
      </button>
    </li>
  </ul>

  {#each mail.accounts as acc (acc.id)}
    {@const open = !collapsed.includes(acc.id)}
    {@const unread = inboxUnread(acc.id)}
    <section class="account" style:--acc={acc.color}>
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
        <button class="toggle" aria-expanded={open} title={acc.email} onclick={() => toggle(acc.id)}>
          <span class="chev" class:shut={!open}><Icon name="chevron" size={14} /></span>
          <span class="acc-name">{!acc.name || acc.name === acc.email.split('@')[1] ? acc.email : acc.name}</span>
          {#if unread && !open}<span class="badge">{unread}</span>{/if}
        </button>
        <button class="new" title={t('folders.accountSettings')} aria-label={`${t('folders.accountSettings')} – ${acc.email}`} onclick={() => openSettings({ accountId: acc.id })}><Icon name="settings" size={14} /></button>
        <button class="new" title={t('actions.newFolder')} aria-label={`${t('actions.newFolder')} – ${acc.email}`} onclick={() => newFolder(acc.id, null)}><Icon name="plus" size={14} /></button>
      </h2>
      <ul class="tree" hidden={!open}>
        {#each foldersOf(acc.id) as f (f.id)}
          <li>
            <button
              class="item"
              class:active={mail.folderId === f.id}
              class:unread={f.unread > 0}
              class:drop={dropTarget === f.id}
              aria-current={mail.folderId === f.id ? 'page' : undefined}
              disabled={!f.selectable}
              style:padding-inline-start={`${0.75 + f.depth * 0.9}rem`}
              onclick={() => selectFolder(f.id)}
              oncontextmenu={(e) => folderMenu(e, f)}
              ondragover={(e) => onDragOver(e, f)}
              ondragleave={() => dropTarget === f.id && (dropTarget = null)}
              ondrop={(e) => onDrop(e, f)}
            >
              <span class="ficon"><Icon name={f.specialUse ? ICON_OF[f.specialUse] : 'folder'} /></span>
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

  {#each mail.archives as a (a.id)}
    {@const open = !collapsed.includes(-a.id)}
    <section class="account archive" aria-label={`${t('archive.label')}: ${a.name}`}>
      <h2>
        <button class="toggle" aria-expanded={open} title={a.path} onclick={() => toggle(-a.id)}>
          <span class="chev" class:shut={!open}><Icon name="chevron" size={14} /></span>
          <span class="arch-icon"><Icon name="archive" size={14} /></span>
          <span class="acc-name">{a.name}</span>
        </button>
        <button class="new close" title={t('archive.close')} aria-label={`${t('archive.close')} – ${a.name}`} onclick={() => closeArchive(a)}><Icon name="close" size={14} /></button>
      </h2>
      {#if a.state === 'indexing'}
        <p class="arch-state">{t('archive.indexing', { pct: archivePercent(a), n: a.progress?.messages ?? 0 })}</p>
      {:else if a.state === 'missing'}
        <p class="arch-state warn">⚠ {t('archive.missing')}</p>
      {:else if a.state === 'failed'}
        <p class="arch-state warn">⚠ {t(`errors.${a.error ?? 'UNKNOWN'}` as MessageKey)}</p>
      {/if}
      <ul class="tree" hidden={!open}>
        {#each mail.archiveFolders.filter((f) => f.accountId === -a.id) as f (f.id)}
          <li>
            <button
              class="item"
              class:active={mail.folderId === f.id}
              class:unread={f.unread > 0}
              aria-current={mail.folderId === f.id ? 'page' : undefined}
              title={`${label(f)} – ${t('archive.count', { n: f.total })}`}
              onclick={() => selectFolder(f.id)}
            >
              <span class="ficon"><Icon name={f.specialUse ? ICON_OF[f.specialUse] : 'folder'} /></span>
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

</nav>

<style>
  .pane {
    height: 100%;
    overflow-y: auto;
    padding: 0.5rem 0.45rem 1rem;
    background: var(--surface-2);
  }
  .tree {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* Každé konto je samostatný blok: podfarbená hlavička s farbou konta a jeho priečinky. */
  .account {
    margin-top: 0.7rem;
    padding-bottom: 0.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    margin: 0 0 0.2rem;
    padding: 0.3rem 0.35rem 0.3rem 0;
    padding-inline: 0 0.35rem;
    border-inline-start: 3px solid var(--acc, var(--text-muted));
    background: var(--surface-3);
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
  }
  .toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.4rem;
    border: 0;
    background: none;
    color: inherit;
    font-weight: 600;
    text-align: start;
    cursor: pointer;
  }
  .chev {
    display: inline-flex;
    color: var(--text-muted);
    transition: transform 0.12s ease;
  }
  .chev.shut {
    transform: rotate(-90deg);
  }
  :global([dir='rtl']) .chev.shut {
    transform: rotate(90deg);
  }
  .acc-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .new {
    flex: none;
    display: inline-flex;
    border: 0;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.2rem;
    border-radius: var(--radius-sm);
    opacity: 0.55;
  }
  .account:hover .new,
  .new:focus-visible {
    opacity: 1;
  }
  .new:hover {
    color: var(--accent);
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .item.drop {
    background: var(--accent-soft);
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.32rem 0.75rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: start;
    cursor: pointer;
  }
  .account .item {
    width: calc(100% - 0.4rem);
    margin-inline: 0.2rem;
  }
  .item:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 6%, transparent);
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
  .icon,
  .ficon {
    display: inline-flex;
    color: var(--text-muted);
  }
  .item.active .ficon,
  .item.active .icon {
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
    font-weight: 650;
    color: var(--accent);
  }
  .arch-icon {
    display: inline-flex;
    color: var(--text-muted);
  }
  .archive h2 {
    border-inline-start-color: var(--text-muted);
  }
  .new.close {
    opacity: 1;
  }
  .arch-state {
    margin: 0.1rem 0.75rem 0.3rem;
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .arch-state.warn {
    color: var(--warning);
  }
</style>
