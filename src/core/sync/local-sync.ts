import type { SyncStatus } from '../../shared/ipc'
import type { FolderRow } from '../store/mailstore'
import { DEFAULT_NAMES, type AccountRow, type MovePayload, type SyncDeps } from './account-sync'
import { createLocalFolder, deletableSubtree, renameLocalFolder } from './local-folders'
import { logger } from '../log'

const log = logger('sync')

/**
 * Konto „len v počítači“: schránka na serveri už neexistuje (alebo ju používateľ nechce používať).
 * Doar sa na server nepripája. Presuny, mazanie, príznaky a priečinky sa robia len v lokálnej databáze;
 * originály správ (.eml) ostávajú. Správy, ktorých obsah sa nestihol stiahnuť, sa už nestiahnu.
 */
export class LocalSync {
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  status: SyncStatus

  constructor(
    private account: AccountRow,
    private deps: SyncDeps
  ) {
    this.status = { accountId: account.id, state: 'idle', pendingBodies: 0, pendingChanges: 0, lastSync: null }
  }

  get id(): number {
    return this.account.id
  }

  start(): void {
    this.stopped = false
    // Predošlý stav (napr. chyba prihlásenia ku zrušenej schránke) už neplatí.
    this.deps.emit('sync.status', this.status)
    // Zmeny, ktoré čakali na server ešte pred odpojením, sa dokončia lokálne.
    void this.pushOperations()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Nie je čo synchronizovať. */
  requestSync(): Promise<void> {
    return Promise.resolve()
  }

  /** Obsah sa nedá stiahnuť – volajúci ohlási, že správa nie je k dispozícii. */
  fetchBodyNow(_messageId: number): Promise<void> {
    return Promise.resolve()
  }

  processOutboxNow(): Promise<void> {
    return Promise.resolve()
  }

  reconnectNow(): void {}

  refreshStatus(): void {
    this.deps.emit('sync.status', this.status)
  }

  /** Odložené presuny (čas na „Vrátiť späť“) sa vykonajú, keď uplynie ich čas. */
  scheduleDelayedOperations(): void {
    if (this.stopped) return
    const ms = this.deps.store.nextDelayedOperation(this.account.id)
    if (ms === null) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pushOperations()
    }, ms + 50)
  }

  /** Čakajúce zmeny sa vykonajú lokálne. */
  pushOperations(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const store = this.deps.store
    const touched = new Set<number>()
    for (const op of store.pendingOperations(this.account.id)) {
      if (!store.claimOperation(op.id)) continue
      try {
        this.runOperation(op.kind, op.payload, touched)
        store.finishOperation(op.id, true)
      } catch (e) {
        log.warn('lokálna zmena zlyhala', { account: this.account.id, kind: op.kind, error: e })
        store.abandonOperation(op.id, (e as { code?: string }).code ?? 'ERROR')
      }
    }
    if (touched.size) this.changed([...touched])
    this.scheduleDelayedOperations()
    return Promise.resolve()
  }

  private runOperation(kind: string, payload: unknown, touched: Set<number>): void {
    const store = this.deps.store
    if (kind === 'flags') {
      const p = payload as { folderId: number; messageIds: number[] }
      store.setLocalState(p.messageIds, 'synced')
      touched.add(p.folderId)
    } else if (kind === 'move') {
      const p = payload as MovePayload
      touched.add(p.fromFolderId)
      const target = p.toFolderId !== undefined ? store.folder(p.toFolderId) : this.specialFolder(p.toSpecial!)
      if (!target) {
        // Cieľ medzičasom zmizol – správy ostanú, kde boli.
        store.setHidden(p.messageIds, false)
        return
      }
      store.moveLocal(p.messageIds, target.id)
      touched.add(target.id)
    } else if (kind === 'expunge') {
      const p = payload as { folderId: number; messageIds: number[] }
      store.deleteMessages(p.messageIds)
      touched.add(p.folderId)
    } else if (kind === 'draftDelete') {
      const p = payload as { draftId: number }
      if (store.draft(p.draftId)) store.deleteDraft(p.draftId)
    } else if (kind === 'folderDelete') {
      // Priečinok odstránený bez pripojenia ešte pred odpojením konta: dokončiť lokálne.
      const p = payload as { folderIds: number[]; messageIds: number[] }
      const trash = this.specialFolder('trash')
      if (trash) {
        store.moveLocal(p.messageIds, trash.id)
        touched.add(trash.id)
      }
      store.deleteFolderRows(p.folderIds)
    }
    // draft, draftRemove, folderCreate, folderRename: lokálny stav je už hotový, server nie je.
  }

  /** Špeciálny priečinok (Kôš, Archív, Spam); ak chýba, založí sa lokálne. */
  private specialFolder(use: 'trash' | 'archive' | 'junk'): FolderRow | null {
    const store = this.deps.store
    const f = store.specialFolder(this.account.id, use) ?? (use === 'archive' ? store.specialFolder(this.account.id, 'all') : null)
    if (f) return f
    try {
      return store.folder(createLocalFolder(store, this.account.id, null, DEFAULT_NAMES[use], use).id)
    } catch {
      return null
    }
  }

  createFolder(parentPath: string | null, name: string): Promise<number> {
    try {
      const { id } = createLocalFolder(this.deps.store, this.account.id, parentPath, name)
      this.deps.emit('folders.changed', { accountId: this.account.id })
      return Promise.resolve(id)
    } catch (e) {
      return Promise.reject(e)
    }
  }

  renameFolder(oldPath: string, parentPath: string | null, name: string): Promise<void> {
    try {
      renameLocalFolder(this.deps.store, this.account.id, oldPath, parentPath, name)
      this.deps.emit('folders.changed', { accountId: this.account.id })
      return Promise.resolve()
    } catch (e) {
      return Promise.reject(e)
    }
  }

  /** Odstránenie priečinka: správy (aj z podpriečinkov) idú do Koša, priečinky sa zmažú. */
  deleteFolder(path: string): Promise<{ moved: number; labelsOnly: boolean }> {
    try {
      const store = this.deps.store
      const rows = deletableSubtree(store, this.account.id, path)
      const trash = this.specialFolder('trash')
      if (!trash) throw Object.assign(new Error('Kôš sa nepodarilo založiť'), { code: 'FOLDER_DELETE_FAILED' })
      const ids = rows.flatMap((r) => store.folderMessageIds(r.id))
      store.moveLocal(ids, trash.id)
      store.deleteFolderRows(rows.map((r) => r.id))
      this.changed([trash.id])
      return Promise.resolve({ moved: ids.length, labelsOnly: false })
    } catch (e) {
      return Promise.reject(e)
    }
  }

  private changed(folderIds: number[]): void {
    const store = this.deps.store
    const live = folderIds.filter((id) => store.folder(id))
    store.recountLocal(live)
    this.deps.emit('messages.changed', { folderIds: live })
    this.deps.emit('folders.changed', { accountId: this.account.id })
  }
}
