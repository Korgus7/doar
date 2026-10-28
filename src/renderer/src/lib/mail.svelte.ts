import type { AccountSummary, ArchiveSummary, FolderItem, MessageListItem, SearchFilters, SyncStatus } from '../../../shared/ipc'
import { isArchiveId } from '../../../shared/ipc'

/**
 * Stav pošty v rozhraní. Údaje drží jadro; tu je len to, čo je práve zobrazené.
 * Zoznam správ sa načítava po stránkach podľa toho, čo je vidno (aj pri desaťtisícoch správ).
 */
export const PAGE = 200

export const mail = $state({
  accounts: [] as AccountSummary[],
  folders: [] as FolderItem[],
  /** Otvorené lokálne archívy (súbory mbox len na čítanie) a ich priečinky (záporné ID). */
  archives: [] as ArchiveSummary[],
  archiveFolders: [] as FolderItem[],
  /** null = spoločná doručená pošta všetkých kont */
  folderId: null as number | null,
  total: 0,
  pages: {} as Record<number, MessageListItem[]>,
  /** Otvorená správa – len keď je vybraná práve jedna. */
  selectedId: null as number | null,
  /** Vybrané správy (Ctrl/Shift + klik, Ctrl+A). */
  selection: [] as number[],
  /** Riadok s fokusom klávesnice (pri viacnásobnom výbere nemusí byť otvorený). */
  cursor: null as number | null,
  statuses: {} as Record<number, SyncStatus>,
  listVersion: 0,
  /** Vyhľadávanie: zoznam namiesto priečinka ukazuje výsledky. scope 'folder' = len v zobrazenom priečinku. */
  search: null as null | { query: string; scope: 'all' | 'folder'; filters?: SearchFilters },
  /** Koľko správ v rozsahu hľadania ešte nemá stiahnutý text. */
  searchNotDownloaded: 0,
  /** Zobrazenie po konverzáciách (nastavenie; neplatí pre hľadanie a archív). */
  threads: false
})

/** Zoznam je práve zoskupený do konverzácií? */
export function threadView(): boolean {
  return mail.threads && !mail.search && !isArchiveId(mail.folderId)
}

/** Riadok konverzácie → všetky jej správy v priečinku (presun, mazanie, príznaky platia pre celú konverzáciu). */
export function expandThreads(ids: number[]): number[] {
  const out = new Set<number>()
  const items = new Map(itemsById(ids).map((m) => [m.id, m]))
  for (const id of ids) {
    out.add(id)
    for (const x of items.get(id)?.threadIds ?? []) out.add(x)
  }
  return [...out]
}

/** Zapne/vypne konverzácie (uloží sa do nastavení) a načíta zoznam znova. */
export async function setThreads(on: boolean): Promise<void> {
  await window.doar.invoke('settings.set', { threads: on })
  mail.threads = on
  setSelection([])
  await reloadList()
}

/** Rozsah hľadania pre jadro. Pri spoločnej doručenej pošte „tento priečinok“ = všade; v archíve „všade“ = celý archív. */
function searchScope(): { folderId: number | null; archiveId?: number } {
  if (isArchiveId(mail.folderId) && mail.search?.scope !== 'folder') {
    const f = findFolder(mail.folderId)
    if (f) return { folderId: null, archiveId: -f.accountId }
  }
  return { folderId: mail.search?.scope === 'folder' ? mail.folderId : null }
}

/** Priečinok podľa ID (konto aj archív). */
export function findFolder(id: number | null | undefined): FolderItem | undefined {
  if (id == null) return undefined
  return isArchiveId(id) ? mail.archiveFolders.find((f) => f.id === id) : mail.folders.find((f) => f.id === id)
}

export async function loadArchives(): Promise<void> {
  const r = await window.doar.invoke('archives.list')
  mail.archives = r.archives
  mail.archiveFolders = r.folders
  // Zobrazený priečinok archívu zmizol (archív zatvorený alebo sa načítava znova) → doručená pošta.
  if (isArchiveId(mail.folderId) && !mail.archiveFolders.some((f) => f.id === mail.folderId)) await selectFolder(null)
}

/** Kľúč zobrazeného zoznamu – výsledky, ktoré prídu po zmene priečinka alebo hľadania, sa zahodia. */
function listKey(): string {
  return JSON.stringify([mail.folderId, mail.search, mail.threads])
}

const loading = new Set<number>()

export function messageAt(index: number): MessageListItem | undefined {
  return mail.pages[Math.floor(index / PAGE)]?.[index % PAGE]
}

export async function loadPage(page: number, force = false): Promise<void> {
  if (!force && (mail.pages[page] || loading.has(page))) return
  loading.add(page)
  const key = listKey()
  try {
    if (mail.search) {
      const r = await window.doar.invoke('messages.search', {
        query: mail.search.query,
        ...(mail.search.filters ? { filters: { ...mail.search.filters } } : {}),
        ...searchScope(),
        offset: page * PAGE,
        limit: PAGE
      })
      if (key !== listKey()) return // medzitým iné hľadanie alebo priečinok
      mail.total = r.total
      mail.searchNotDownloaded = r.notDownloaded
      mail.pages[page] = r.items
      return
    }
    const r = await window.doar.invoke('messages.list', { folderId: mail.folderId, offset: page * PAGE, limit: PAGE, threads: threadView() })
    if (key !== listKey()) return // medzitým sa prepol priečinok
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
  mail.search = null
  await reloadList()
}

/** Spustí (alebo zmení) hľadanie. Prázdny text → späť na priečinok. */
/** Vyplnený filter rozšíreného hľadania (prázdne polia sa nerátajú). */
export function activeFilters(f: SearchFilters | undefined): SearchFilters | undefined {
  if (!f) return undefined
  const out: SearchFilters = {}
  for (const k of ['from', 'to', 'subject', 'after', 'before'] as const) if (f[k]?.trim()) out[k] = f[k]!.trim()
  for (const k of ['attachment', 'unread', 'flagged'] as const) if (f[k]) out[k] = true
  return Object.keys(out).length ? out : undefined
}

/** filters: undefined = ponechať doterajšie, null = zrušiť. */
export async function runSearch(query: string, scope: 'all' | 'folder' = mail.search?.scope ?? 'all', filters?: SearchFilters | null): Promise<void> {
  const f = activeFilters(filters === undefined ? mail.search?.filters : (filters ?? undefined))
  mail.search = query.trim() || f ? { query: query.trim(), scope, ...(f ? { filters: f } : {}) } : null
  await reloadList()
}

async function reloadList(): Promise<void> {
  mail.pages = {}
  mail.total = 0
  setSelection([], null)
  loading.clear()
  await loadPage(0, true)
  mail.listVersion++
}

/** Zobrazuje sa práve priečinok, ktorého sa zmena týka? */
export function affectsCurrent(folderIds: number[]): boolean {
  if (mail.search) return true
  if (mail.folderId === null) return folderIds.some((id) => mail.folders.find((f) => f.id === id)?.specialUse === 'inbox')
  return folderIds.includes(mail.folderId)
}

export function patchMessage(id: number, patch: Partial<MessageListItem>): void {
  for (const items of Object.values(mail.pages)) {
    const m = items.find((x) => x.id === id)
    if (m) Object.assign(m, patch)
  }
}

export async function setFlags(list: number[], change: { seen?: boolean; flagged?: boolean }): Promise<void> {
  // Archív je len na čítanie.
  const own = list.filter((id) => !isArchiveId(id))
  // Prečítané platí pre celú konverzáciu, hviezdička len pre označenú správu.
  const ids = change.seen !== undefined ? expandThreads(own) : own
  if (!ids.length) return
  for (const id of ids) patchMessage(id, { ...change, localState: 'pending' })
  await window.doar.invoke('messages.setFlags', { ids: [...ids], ...change })
}

/** Nastaví výber. Pri jednej správe ju otvorí, pri viacerých sa čítanie nezobrazí (a neoznačia sa ako prečítané). */
export function setSelection(ids: number[], cursor: number | null = ids.at(-1) ?? null): void {
  mail.selection = ids
  mail.cursor = cursor
  mail.selectedId = ids.length === 1 ? ids[0]! : null
}

export function isSelected(id: number): boolean {
  return mail.selection.includes(id)
}

/** Index správy v zobrazenom zozname (len v načítaných stránkach), inak -1. */
export function indexOf(id: number | null): number {
  if (id === null) return -1
  for (const [p, items] of Object.entries(mail.pages)) {
    const i = items.findIndex((x) => x.id === id)
    if (i >= 0) return Number(p) * PAGE + i
  }
  return -1
}

/** Všetky správy zobrazeného priečinka (aj nenačítané stránky) v poradí zoznamu. */
export async function allIds(): Promise<number[]> {
  if (mail.search) return window.doar.invoke('messages.searchIds', { query: mail.search.query, ...(mail.search.filters ? { filters: { ...mail.search.filters } } : {}), ...searchScope() })
  return window.doar.invoke('messages.listIds', { folderId: mail.folderId, threads: threadView() })
}

/** Správy z načítaných stránok podľa id (napr. pre kontextovú ponuku). */
export function itemsById(ids: number[]): MessageListItem[] {
  const want = new Set(ids)
  const out: MessageListItem[] = []
  for (const items of Object.values(mail.pages)) for (const m of items) if (want.has(m.id)) out.push(m)
  return out
}
