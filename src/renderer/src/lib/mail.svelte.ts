import type { AccountSummary, FolderItem, MessageListItem, SyncStatus } from '../../../shared/ipc'

/**
 * Stav pošty v rozhraní. Údaje drží jadro; tu je len to, čo je práve zobrazené.
 * Zoznam správ sa načítava po stránkach podľa toho, čo je vidno (aj pri desaťtisícoch správ).
 */
export const PAGE = 200

export const mail = $state({
  accounts: [] as AccountSummary[],
  folders: [] as FolderItem[],
  /** null = spoločná doručená pošta všetkých kont */
  folderId: null as number | null,
  total: 0,
  pages: {} as Record<number, MessageListItem[]>,
  selectedId: null as number | null,
  statuses: {} as Record<number, SyncStatus>,
  listVersion: 0
})

const loading = new Set<number>()

export function messageAt(index: number): MessageListItem | undefined {
  return mail.pages[Math.floor(index / PAGE)]?.[index % PAGE]
}

export async function loadPage(page: number, force = false): Promise<void> {
  if (!force && (mail.pages[page] || loading.has(page))) return
  loading.add(page)
  const folderId = mail.folderId
  try {
    const r = await window.doar.invoke('messages.list', { folderId, offset: page * PAGE, limit: PAGE })
    if (folderId !== mail.folderId) return // medzitým sa prepol priečinok
    mail.total = r.total
    mail.pages[page] = r.items
  } finally {
    loading.delete(page)
  }
}

/** Znovu načíta už zobrazené stránky (po zmene zo synchronizácie). */
export async function refreshList(): Promise<void> {
  const pages = Object.keys(mail.pages).map(Number)
  if (!pages.length) pages.push(0)
  await Promise.all(pages.map((p) => loadPage(p, true)))
  mail.listVersion++
}

export async function loadFolders(): Promise<void> {
  mail.folders = await window.doar.invoke('folders.list')
}

export async function loadAccounts(): Promise<void> {
  mail.accounts = await window.doar.invoke('accounts.list')
}

export async function selectFolder(id: number | null): Promise<void> {
  mail.folderId = id
  mail.pages = {}
  mail.total = 0
  mail.selectedId = null
  loading.clear()
  await loadPage(0, true)
  mail.listVersion++
}

/** Zobrazuje sa práve priečinok, ktorého sa zmena týka? */
export function affectsCurrent(folderIds: number[]): boolean {
  if (mail.folderId === null) return folderIds.some((id) => mail.folders.find((f) => f.id === id)?.specialUse === 'inbox')
  return folderIds.includes(mail.folderId)
}

export function patchMessage(id: number, patch: Partial<MessageListItem>): void {
  for (const items of Object.values(mail.pages)) {
    const m = items.find((x) => x.id === id)
    if (m) Object.assign(m, patch)
  }
}

export async function setFlags(ids: number[], change: { seen?: boolean; flagged?: boolean }): Promise<void> {
  for (const id of ids) patchMessage(id, { ...change, localState: 'pending' })
  await window.doar.invoke('messages.setFlags', { ids, ...change })
}
