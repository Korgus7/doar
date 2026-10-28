<script lang="ts">
  import type { FolderItem } from '../../../shared/ipc'
  import { t } from '../i18n/index.svelte'
  import { mail, selectFolder, loadAccounts } from '../lib/mail.svelte'
  import { closeArchive, archivePercent } from '../lib/archive.svelte'
  import type { MessageKey } from '../i18n/index.svelte'
  import { ui, moveTo, openMenu, folderLabel, deleteFolder, renameFolder, descendantIds, showToast, errorText, type MenuEntry } from '../lib/actions.svelte'
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
  /** Konto, na ktorého hlavičku sa práve ťahá priečinok (presun na najvyššiu úroveň). */
  let headDrop = $state<number | null>(null)

  /** Dajú sa ťahané správy pustiť na tento priečinok? (len v rámci konta, nie do toho istého priečinka) */
  function canDrop(f: FolderItem): boolean {
    const d = ui.dragging
    if (!d || !f.selectable) return false
    if (d.accountIds.length !== 1 || d.accountIds[0] !== f.accountId) return false
    return !(d.ids.length && mail.folderId === f.id)
  }

  /** Bežný priečinok sa dá ťahať (presun pod iný priečinok). Doručená pošta a špeciálne priečinky nie. */
  const movable = (f: FolderItem): boolean => !f.specialUse && f.path.toUpperCase() !== 'INBOX'

  /** Dá sa ťahaný priečinok pustiť sem? (to isté konto, nie do seba, podpriečinka ani tam, kde už je) */
  function canDropFolder(f: FolderItem | null, accountId: number): boolean {
    const d = ui.draggingFolder
    if (!d || d.accountId !== accountId) return false
    const dragged = mail.folders.find((x) => x.id === d.id)
    if (!dragged) return false
    if (f === null) return dragged.parentPath !== null
    if (f.id === dragged.id || descendantIds(dragged).has(f.id)) return false
    return dragged.parentPath !== f.path
  }

  async function dropFolder(target: FolderItem | null, accountId: number): Promise<void> {
    const d = ui.draggingFolder
    const ok = canDropFolder(target, accountId)
    ui.draggingFolder = null
    dropTarget = null
    if (!d || !ok) return
    const dragged = mail.folders.find((x) => x.id === d.id)
    if (!dragged) return
    try {
      await renameFolder(dragged.id, dragged.name, target?.id ?? null)
    } catch (err) {
      showToast(errorText(err), { tone: 'error' })
    }
  }

  function onDragStartFolder(e: DragEvent, f: FolderItem): void {
    if (!movable(f)) {
      e.preventDefault()
      return
    }
    ui.draggingFolder = { id: f.id, accountId: f.accountId }
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', label(f))
    }
  }

  function onDragOver(e: DragEvent, f: FolderItem): void {
    if (ui.draggingFolder) {
      if (!canDropFolder(f, f.accountId)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      dropTarget = f.id
      return
    }
    if (!canDrop(f)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropTarget = f.id
  }

  function onDrop(e: DragEvent, f: FolderItem): void {
    if (ui.draggingFolder) {
      e.preventDefault()
      void dropFolder(f, f.accountId)
      return
    }
    const d = ui.dragging
    dropTarget = null
    if (!d || !canDrop(f)) return
    e.preventDefault()
    ui.dragging = null
    void moveTo(d.ids, { folderId: f.id })
  }

  /** Ťahané konto (zmena poradia kont) a konto, nad ktorým práve je. */
  let draggingAcc = $state<number | null>(null)
  let accDrop = $state<number | null>(null)

  /** Presunie konto na miesto iného konta (alebo o jedno vyššie/nižšie). */
  async function moveAccount(id: number, to: number): Promise<void> {
    const list = [...mail.accounts]
    const from = list.findIndex((a) => a.id === id)
    if (from < 0 || to < 0 || to >= list.length || to === from) return
    const [acc] = list.splice(from, 1)
    list.splice(to, 0, acc!)
    mail.accounts = list
    try {
      await window.doar.invoke('accounts.reorder', { ids: list.map((a) => a.id) })
    } catch (err) {
      showToast(errorText(err), { tone: 'error' })
      await loadAccounts().catch(() => {})
    }
  }

  function onAccDrop(target: number): void {
    const id = draggingAcc
    draggingAcc = null
    accDrop = null
    if (id === null || id === target) return
    void moveAccount(id, mail.accounts.findIndex((a) => a.id === target))
  }

  function newFolder(accountId: number, parentId: number | null): void {
    ui.newFolder = { accountId, parentId }
  }

  /** Označí všetko v priečinku (null = spoločná doručená pošta) ako prečítané. */
  async function markFolderRead(folderId: number | null): Promise<void> {
    try {
      const r = await window.doar.invoke('messages.markFolderRead', { folderId })
      showToast(r.count ? t('actions.markedRead', { n: r.count }) : t('actions.nothingUnread'))
    } catch (err) {
      showToast(errorText(err), { tone: 'error' })
    }
  }

  async function runRules(f: FolderItem): Promise<void> {
    try {
      const r = await window.doar.invoke('rules.run', { folderId: f.id })
      showToast(t('rules.ranCount', { n: r.applied }))
    } catch (err) {
      showToast(errorText(err), { tone: 'error' })
    }
  }

  function folderMenu(e: MouseEvent, f: FolderItem): void {
    e.preventDefault()
    const items: MenuEntry[] = [
      { label: t('actions.markFolderRead'), disabled: !f.unread, run: () => void markFolderRead(f.id) },
      { label: t('rules.runOnFolder'), run: () => void runRules(f) },
      'sep'
    ]
    items.push({ label: t('actions.newSubfolder'), run: () => newFolder(f.accountId, f.id) })
    if (!f.specialUse && f.path.toUpperCase() !== 'INBOX') {
      items.push({ label: t('actions.renameFolder'), run: () => (ui.newFolder = { accountId: f.accountId, parentId: null, editId: f.id }) })
      items.push({ label: t('actions.deleteFolder'), run: () => void deleteFolder(f) })
    }
    openMenu(e.clientX, e.clientY, items, label(f))
  }

  // Zbalené priečinky s podpriečinkami (podľa id) – pamätá sa v tomto počítači.
  const FOLDERS_KEY = 'doar.collapsedFolders'
  let shut = $state<number[]>(loadShut())
  function loadShut(): number[] {
    try {
      const v = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]') as unknown
      return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []
    } catch {
      return []
    }
  }
  function toggleFolder(id: number): void {
    shut = shut.includes(id) ? shut.filter((x) => x !== id) : [...shut, id]
    try {
      localStorage.setItem(FOLDERS_KEY, JSON.stringify(shut))
    } catch {
      /* nezapamätá sa */
    }
  }

  const key = (accountId: number, path: string): string => `${accountId}\u0000${path}`
  const byPath = $derived(new Map(mail.folders.map((f) => [key(f.accountId, f.path), f])))
  const parents = $derived(new Set(mail.folders.filter((f) => f.parentPath !== null).map((f) => key(f.accountId, f.parentPath!))))
  const hasChildren = (f: FolderItem): boolean => parents.has(key(f.accountId, f.path))

  /** Priečinok je skrytý, ak je niektorý z jeho nadradených priečinkov zbalený. */
  function hiddenByParent(f: FolderItem): boolean {
    let p = f.parentPath
    for (let i = 0; p !== null && i < 64; i++) {
      const parent = byPath.get(key(f.accountId, p))
      if (!parent) return false
      if (shut.includes(parent.id)) return true
      p = parent.parentPath
    }
    return false
  }

  /** Neprečítané v skrytých podpriečinkoch zbaleného priečinka (aby sa nestratili z očí). */
  function hiddenUnread(f: FolderItem): number {
    const prefix = f.path
    return mail.folders
      .filter((x) => x.accountId === f.accountId && x.id !== f.id && x.parentPath !== null && isUnder(x, prefix))
      .filter((x) => x.specialUse !== 'sent' && x.specialUse !== 'drafts' && x.specialUse !== 'trash')
      .reduce((s, x) => s + x.unread, 0)
  }
  function isUnder(x: FolderItem, ancestorPath: string): boolean {
    let p = x.parentPath
    for (let i = 0; p !== null && i < 64; i++) {
      if (p === ancestorPath) return true
      p = byPath.get(key(x.accountId, p))?.parentPath ?? null
    }
    return false
  }

  function foldersOf(accountId: number): FolderItem[] {
    return mail.folders.filter((f) => f.accountId === accountId && !hiddenByParent(f))
  }
</script>

<nav class="pane" aria-label={t('folders.label')}>
  <ul class="tree">
    <li>
      <button
        class="item unified"
        class:active={mail.folderId === null}
        aria-current={mail.folderId === null ? 'page' : undefined}
        onclick={() => selectFolder(null)}
        oncontextmenu={(e) => {
          e.preventDefault()
          openMenu(e.clientX, e.clientY, [{ label: t('actions.markFolderRead'), disabled: !unifiedUnread, run: () => void markFolderRead(null) }], t('folders.unifiedInbox'))
        }}
      >
        <span class="icon"><Icon name="inboxes" /></span>
        <span class="name">{t('folders.unifiedInbox')}</span>
        {#if unifiedUnread}<span class="badge">{unifiedUnread}</span>{/if}
      </button>
    </li>
  </ul>

  {#each mail.accounts as acc, i (acc.id)}
    {@const open = !collapsed.includes(acc.id)}
    {@const unread = inboxUnread(acc.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section
      class="account"
      class:acc-drop={accDrop === acc.id && draggingAcc !== acc.id}
      class:acc-up={accDrop === acc.id && draggingAcc !== null && mail.accounts.findIndex((a) => a.id === draggingAcc) > i}
      style:--acc={acc.color}
      ondragover={(e) => {
        if (draggingAcc === null) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        accDrop = acc.id
      }}
      ondragleave={(e) => {
        if (accDrop === acc.id && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) accDrop = null
      }}
      ondrop={(e) => {
        if (draggingAcc === null) return
        e.preventDefault()
        onAccDrop(acc.id)
      }}
    >
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <h2
        class:drop={headDrop === acc.id}
        ondragover={(e) => {
          if (!canDropFolder(null, acc.id)) return
          e.preventDefault()
          headDrop = acc.id
        }}
        ondragleave={() => headDrop === acc.id && (headDrop = null)}
        ondrop={(e) => {
          if (!ui.draggingFolder) return
          e.preventDefault()
          headDrop = null
          void dropFolder(null, acc.id)
        }}
        oncontextmenu={(e) => {
          e.preventDefault()
          const items: MenuEntry[] = [
            { label: t('actions.newFolder'), run: () => newFolder(acc.id, null) },
            { label: t('folders.accountSettings'), run: () => openSettings({ accountId: acc.id }) }
          ]
          if (mail.accounts.length > 1) {
            items.push(
              'sep',
              { label: t('folders.accountUp'), disabled: i === 0, run: () => void moveAccount(acc.id, i - 1) },
              { label: t('folders.accountDown'), disabled: i === mail.accounts.length - 1, run: () => void moveAccount(acc.id, i + 1) }
            )
          }
          openMenu(e.clientX, e.clientY, items, acc.email)
        }}
      >
        <button
          class="toggle"
          aria-expanded={open}
          title={acc.email}
          onclick={() => toggle(acc.id)}
          draggable={mail.accounts.length > 1 ? 'true' : undefined}
          ondragstart={(e) => {
            draggingAcc = acc.id
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', acc.email)
            }
          }}
          ondragend={() => ((draggingAcc = null), (accDrop = null))}
        >
          <span class="chev" class:shut={!open}><Icon name="chevron" size={14} /></span>
          <span class="dot" aria-hidden="true"></span>
          <span class="acc-name">{!acc.name || acc.name === acc.email.split('@')[1] ? acc.email : acc.name}</span>
          {#if unread && !open}<span class="badge">{unread}</span>{/if}
        </button>
        <button class="new" title={t('folders.accountSettings')} aria-label={`${t('folders.accountSettings')} – ${acc.email}`} onclick={() => openSettings({ accountId: acc.id })}><Icon name="settings" size={14} /></button>
        <button class="new" title={t('actions.newFolder')} aria-label={`${t('actions.newFolder')} – ${acc.email}`} onclick={() => newFolder(acc.id, null)}><Icon name="plus" size={14} /></button>
      </h2>
      <ul class="tree" hidden={!open}>
        {#each foldersOf(acc.id) as f (f.id)}
          {@const parent = hasChildren(f)}
          {@const closed = parent && shut.includes(f.id)}
          {@const badge = (f.specialUse !== 'sent' && f.specialUse !== 'drafts' && f.specialUse !== 'trash' ? f.unread : 0) + (closed ? hiddenUnread(f) : 0)}
          <li class="row">
            {#if parent}
              <button
                class="fold"
                aria-expanded={!closed}
                aria-label={t('folders.subfolders', { name: label(f) })}
                title={t('folders.subfolders', { name: label(f) })}
                style:inset-inline-start={`${0.2 + f.depth * 0.9}rem`}
                onclick={() => toggleFolder(f.id)}
              ><span class="chev" class:shut={closed}><Icon name="chevron" size={13} /></span></button>
            {/if}
            <button
              class="item"
              class:active={mail.folderId === f.id}
              class:unread={f.unread > 0}
              class:drop={dropTarget === f.id}
              aria-current={mail.folderId === f.id ? 'page' : undefined}
              disabled={!f.selectable}
              style:padding-inline-start={`${1.25 + f.depth * 0.9}rem`}
              onclick={() => selectFolder(f.id)}
              oncontextmenu={(e) => folderMenu(e, f)}
              draggable={movable(f) ? 'true' : undefined}
              ondragstart={(e) => onDragStartFolder(e, f)}
              ondragend={() => ((ui.draggingFolder = null), (dropTarget = null), (headDrop = null))}
              ondragover={(e) => onDragOver(e, f)}
              ondragleave={() => dropTarget === f.id && (dropTarget = null)}
              ondrop={(e) => onDrop(e, f)}
            >
              <span class="ficon"><Icon name={f.specialUse ? ICON_OF[f.specialUse] : 'folder'} /></span>
              <span class="name">{label(f)}</span>
              {#if badge}
                <span class="badge">{badge}</span>
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
    border-inline-start: 5px solid var(--acc, var(--text-muted));
    background: color-mix(in srgb, var(--acc, transparent) 18%, var(--surface-3));
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
  .dot {
    flex: none;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 2px;
    background: var(--acc);
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
  /* Miesto, kam padne ťahané konto: čiara pod kontom (pri ťahaní nahor nad ním). */
  .account.acc-drop {
    box-shadow: 0 3px 0 0 var(--accent);
  }
  .account.acc-drop.acc-up {
    box-shadow: 0 -3px 0 0 var(--accent);
  }
  h2.drop,
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
  .row {
    position: relative;
  }
  .fold {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    display: inline-flex;
    padding: 0.15rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    cursor: pointer;
  }
  .fold:hover {
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
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
