import type { Db } from '../store/db'
import type { BlobStore } from '../store/blobs'
import type { MailStore } from '../store/mailstore'
import type { Secrets } from '../secrets'
import { passwordKey } from '../secrets'
import type { CoreEvents, EventChannel, SyncStatus } from '../../shared/ipc'
import type { ImapFlow } from 'imapflow'
import { AccountSync, type AccountRow, type MovePayload, type SyncDeps } from './account-sync'
import { GraphSync } from './graph-sync'
import type { GraphFetch } from '../graph/client'
import { createImapClient } from '../mail/imap'
import type { OAuthService } from '../oauth/oauth'

/** Synchronizácia jedného konta: IMAP + SMTP, alebo Microsoft Graph. */
export type MailSync = AccountSync | GraphSync

/** Spravuje synchronizáciu všetkých kont. */
export class SyncManager {
  private syncs = new Map<number, MailSync>()
  private graphOpts: { graphBase?: string; graphFetch?: GraphFetch }
  private deps: SyncDeps
  private undoDelayMs: number
  /** Odstup nahratia konceptu na server od posledného uloženia (ms). */
  readonly draftDelayMs: number

  constructor(opts: {
    db: Db
    store: MailStore
    blobs: BlobStore
    secrets: Secrets
    sessionSecrets: Secrets
    emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
    clientFactory?: SyncDeps['clientFactory']
    smtpSend?: SyncDeps['smtpSend']
    /** Prihlásenie cez účet poskytovateľa (prístupové tokeny). */
    oauth?: OAuthService
    /** Čas na „Vrátiť späť“ pred vykonaním presunu na serveri (ms). */
    undoDelayMs?: number
    draftDelayMs?: number
    onNewMail?: SyncDeps['onNewMail']
    onArrived?: SyncDeps['onArrived']
    /** Pre testy: falošný server Microsoft Graph. */
    graphBase?: string
    graphFetch?: GraphFetch
  }) {
    this.graphOpts = { graphBase: opts.graphBase, graphFetch: opts.graphFetch }
    this.undoDelayMs = opts.undoDelayMs ?? 8000
    this.draftDelayMs = opts.draftDelayMs ?? 30_000
    this.deps = {
      db: opts.db,
      store: opts.store,
      blobs: opts.blobs,
      emit: opts.emit,
      clientFactory: opts.clientFactory,
      smtpSend: opts.smtpSend,
      onNewMail: opts.onNewMail,
      onArrived: opts.onArrived,
      onAuthRejected: (acc) => opts.oauth?.invalidate(acc.id),
      getPassword: async (acc) => {
        if (acc.auth_type === 'oauth2') {
          if (!opts.oauth) throw Object.assign(new Error('Prihlásenie cez poskytovateľa nie je dostupné'), { code: 'OAUTH_NOT_CONFIGURED' })
          return { accessToken: await opts.oauth.accessToken(acc.id, acc.password_storage) }
        }
        return (acc.password_storage === 'session' ? opts.sessionSecrets : opts.secrets).get(passwordKey(acc.id))
      }
    }
  }

  private accountRow(id: number): AccountRow | null {
    return (this.deps.db
      .prepare(
        'SELECT id, email, username, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, save_sent_copy, display_name, password_storage, auth_type, protocol FROM accounts WHERE id = ?'
      )
      .get(id) as unknown as AccountRow | undefined) ?? null
  }

  /**
   * Nové (nepripojené) IMAP spojenie pre konto – pre dlhé úlohy mimo synchronizácie (export),
   * aby neblokovali čítanie a synchronizáciu.
   */
  async newImapClient(accountId: number): Promise<ImapFlow> {
    const row = this.accountRow(accountId)
    if (!row) throw Object.assign(new Error('Konto neexistuje'), { code: 'NO_ACCOUNT' })
    if (row.protocol === 'graph') throw Object.assign(new Error('Pre kontá cez Microsoft Graph zatiaľ nie je dostupné'), { code: 'GRAPH_UNSUPPORTED' })
    const pass = await this.deps.getPassword(row)
    if (!pass) throw Object.assign(new Error('Chýba heslo'), { code: 'PASSWORD_REQUIRED' })
    return this.deps.clientFactory
      ? this.deps.clientFactory(row, pass, false)
      : createImapClient({ host: row.imap_host, port: row.imap_port, security: row.imap_security }, row.username, pass)
  }

  startAll(): void {
    // Odosielanie prerušené pádom aplikácie: nevieme, či správa odišla → rozhodne používateľ.
    this.deps.store.recoverInterruptedSends()
    this.deps.store.resetRunningOperations()
    const ids = (this.deps.db.prepare('SELECT id FROM accounts ORDER BY sort_order, id').all() as { id: number }[]).map((r) => r.id)
    for (const id of ids) this.start(id)
  }

  start(accountId: number): void {
    if (this.syncs.has(accountId)) return
    const row = this.accountRow(accountId)
    if (!row) return
    const s: MailSync = row.protocol === 'graph' ? new GraphSync(row, { ...this.deps, ...this.graphOpts }) : new AccountSync(row, this.deps)
    this.syncs.set(accountId, s)
    s.start()
  }

  async stop(accountId: number): Promise<void> {
    const s = this.syncs.get(accountId)
    this.syncs.delete(accountId)
    await s?.stop()
  }

  /** Nové nastavenia servera: synchronizácia konta začne odznova s novým pripojením. */
  async restart(accountId: number): Promise<void> {
    await this.stop(accountId)
    this.start(accountId)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.syncs.keys()].map((id) => this.stop(id)))
  }

  get(accountId: number): MailSync | undefined {
    return this.syncs.get(accountId)
  }

  statuses(): SyncStatus[] {
    return [...this.syncs.values()].map((s) => s.status)
  }

  /** Sieť je znova k dispozícii – všetky kontá skúsia hneď (bez čakania na odklad). */
  reconnectAll(): void {
    for (const s of this.syncs.values()) s.reconnectNow()
  }

  async syncNow(accountId?: number): Promise<void> {
    const list = accountId === undefined ? [...this.syncs.values()] : [this.syncs.get(accountId)].filter((s): s is MailSync => !!s)
    await Promise.allSettled(list.map((s) => s.requestSync()))
  }

  /**
   * Presun správ (Kôš, Archív, Spam, Doručená pošta alebo konkrétny priečinok).
   * Správy sa hneď skryjú; na serveri sa presun vykoná až po uplynutí času na „Vrátiť späť“.
   * Vráti ID operácií pre „Vrátiť späť“.
   */
  moveMessages(ids: number[], target: { folderId?: number; special?: 'trash' | 'archive' | 'junk' | 'inbox' }): { undo: number[]; count: number } {
    const store = this.deps.store
    const released = this.releasePendingMoves(ids)
    const groups = new Map<number, { accountId: number; fromFolderId: number; uids: number[]; messageIds: number[] }>()
    for (const id of ids) {
      const r = store.message(id)
      if (!r) continue
      const g = groups.get(r.folder_id) ?? { accountId: r.account_id, fromFolderId: r.folder_id, uids: [], messageIds: [] }
      g.uids.push(r.uid)
      g.messageIds.push(r.id)
      groups.set(r.folder_id, g)
    }
    const err = (code: string, msg: string): Error => Object.assign(new Error(msg), { code })
    const targetRow = target.folderId !== undefined ? store.folder(target.folderId) : null
    if (target.folderId !== undefined && !targetRow) throw err('NO_TARGET', 'Cieľový priečinok neexistuje')

    const plans: { g: (typeof groups extends Map<number, infer V> ? V : never); payload: MovePayload }[] = []
    for (const g of groups.values()) {
      let toFolderId: number | undefined
      let toSpecial: MovePayload['toSpecial']
      if (targetRow) {
        if (targetRow.account_id !== g.accountId) throw err('CROSS_ACCOUNT', 'Presun medzi kontami zatiaľ nie je podporovaný')
        toFolderId = targetRow.id
      } else if (target.special === 'inbox') {
        const inbox = store.specialFolder(g.accountId, 'inbox')
        if (!inbox) throw err('NO_TARGET', 'Konto nemá doručenú poštu')
        toFolderId = inbox.id
      } else if (target.special) {
        // Archív: ak server nemá \Archive, ale má „Všetku poštu“ (Gmail), archivuje sa tam.
        const f = store.specialFolder(g.accountId, target.special) ?? (target.special === 'archive' ? store.specialFolder(g.accountId, 'all') : null)
        if (f) toFolderId = f.id
        else toSpecial = target.special
      } else throw err('NO_TARGET', 'Chýba cieľ presunu')
      if (toFolderId === g.fromFolderId) continue
      plans.push({ g, payload: { fromFolderId: g.fromFolderId, uids: g.uids, messageIds: g.messageIds, toFolderId, toSpecial } })
    }
    const undo: number[] = []
    let count = 0
    const notBefore = new Date(Date.now() + this.undoDelayMs)
    for (const { g, payload } of plans) {
      store.setHidden(g.messageIds, true)
      // V cieľovom priečinku sa správa ukáže hneď (so značkou „presúva sa“); na server ide po čase na „Vrátiť späť“.
      if (payload.toFolderId !== undefined) store.setMoving(g.messageIds, payload.toFolderId)
      undo.push(store.enqueueOperation(g.accountId, 'move', payload, notBefore))
      count += g.messageIds.length
      this.syncs.get(g.accountId)?.scheduleDelayedOperations()
    }
    this.afterLocalChange([...released, ...plans.map((p) => p.g.fromFolderId), ...plans.flatMap((p) => (p.payload.toFolderId !== undefined ? [p.payload.toFolderId] : []))])
    return { undo, count }
  }

  /**
   * Správa, ktorá ešte čaká na presun (napr. ju používateľ hneď presúva inam alebo maže): predošlý presun
   * sa zruší a platí posledná voľba. Ostatné správy z toho istého presunu sa presunú ako predtým.
   */
  private releasePendingMoves(ids: number[]): number[] {
    const store = this.deps.store
    const rows = ids.map((id) => store.message(id)).filter((r): r is NonNullable<typeof r> => !!r && r.moving_to !== null)
    if (!rows.length) return []
    const touched: number[] = []
    const want = new Set(rows.map((r) => r.id))
    for (const accountId of new Set(rows.map((r) => r.account_id))) {
      for (const op of store.pendingMoves(accountId)) {
        const p = op.payload as MovePayload
        const hit = p.messageIds.filter((id) => want.has(id))
        if (!hit.length) continue
        if (!store.cancelOperation(op.id)) continue
        const keep = p.messageIds.map((id, i) => ({ id, uid: p.uids[i]! })).filter((x) => !want.has(x.id))
        if (keep.length) {
          store.enqueueOperation(accountId, 'move', { ...p, messageIds: keep.map((x) => x.id), uids: keep.map((x) => x.uid) }, op.notBefore ? new Date(op.notBefore) : undefined)
        }
        store.setHidden(hit, false)
        touched.push(p.fromFolderId, ...(p.toFolderId !== undefined ? [p.toFolderId] : []))
        for (const id of hit) want.delete(id)
      }
    }
    // Presun sa na serveri práve vykonáva – výsledok počkáme (inak by sa správa presúvala dvakrát).
    if (want.size) throw Object.assign(new Error('Správa sa práve presúva'), { code: 'MOVE_IN_PROGRESS' })
    return touched
  }

  /** Natrvalo vymazať (len po potvrdení používateľom v rozhraní). Bez možnosti vrátenia. */
  deleteForever(ids: number[]): void {
    const store = this.deps.store
    const released = this.releasePendingMoves(ids)
    const groups = new Map<number, { accountId: number; folderId: number; uids: number[]; messageIds: number[] }>()
    for (const id of ids) {
      const r = store.message(id)
      if (!r) continue
      const g = groups.get(r.folder_id) ?? { accountId: r.account_id, folderId: r.folder_id, uids: [], messageIds: [] }
      g.uids.push(r.uid)
      g.messageIds.push(r.id)
      groups.set(r.folder_id, g)
    }
    for (const g of groups.values()) {
      store.setHidden(g.messageIds, true)
      store.enqueueOperation(g.accountId, 'expunge', g)
      void this.syncs.get(g.accountId)?.pushOperations().catch(() => {})
    }
    this.afterLocalChange([...released, ...groups.keys()])
  }

  /** „Vrátiť späť“: zruší presuny, ktoré sa na serveri ešte nevykonali. */
  undo(opIds: number[]): { undone: boolean } {
    const store = this.deps.store
    let all = true
    const folders: number[] = []
    for (const id of opIds) {
      const op = store.cancelOperation(id)
      if (!op) {
        all = false
        continue
      }
      const p = op.payload as MovePayload
      store.setHidden(p.messageIds, false)
      folders.push(p.fromFolderId, ...(p.toFolderId !== undefined ? [p.toFolderId] : []))
    }
    this.afterLocalChange(folders)
    return { undone: all }
  }

  async createFolder(accountId: number, parentFolderId: number | null, name: string): Promise<number> {
    const clean = name.trim()
    if (!clean || clean.length > 200 || /[%*\u0000-\u001f]/.test(clean)) throw Object.assign(new Error('Neplatný názov priečinka'), { code: 'INVALID_FOLDER_NAME' })
    const s = this.syncs.get(accountId)
    if (!s) throw Object.assign(new Error('Konto neexistuje'), { code: 'NO_ACCOUNT' })
    const parent = parentFolderId === null ? null : this.deps.store.folder(parentFolderId)
    if (parentFolderId !== null && (!parent || parent.account_id !== accountId)) throw Object.assign(new Error('Nadradený priečinok neexistuje'), { code: 'NO_TARGET' })
    return s.createFolder(parent?.path ?? null, clean)
  }

  /** Premenovanie a/alebo presun pod iný priečinok (parentFolderId null = najvyššia úroveň). */
  async renameFolder(folderId: number, name: string, parentFolderId: number | null): Promise<void> {
    const clean = name.trim()
    if (!clean || clean.length > 200 || /[%*\u0000-\u001f]/.test(clean)) throw Object.assign(new Error('Neplatný názov priečinka'), { code: 'INVALID_FOLDER_NAME' })
    const folder = this.deps.store.folder(folderId)
    if (!folder) throw Object.assign(new Error('Priečinok neexistuje'), { code: 'NO_TARGET' })
    if (folder.special_use || folder.path.toUpperCase() === 'INBOX') throw Object.assign(new Error('Tento priečinok sa nedá premenovať'), { code: 'FOLDER_PROTECTED' })
    const parent = parentFolderId === null ? null : this.deps.store.folder(parentFolderId)
    if (parentFolderId !== null && (!parent || parent.account_id !== folder.account_id)) throw Object.assign(new Error('Nadradený priečinok neexistuje'), { code: 'NO_TARGET' })
    const s = this.syncs.get(folder.account_id)
    if (!s) throw Object.assign(new Error('Konto neexistuje'), { code: 'NO_ACCOUNT' })
    return s.renameFolder(folder.path, parent?.path ?? null, clean)
  }

  async deleteFolder(folderId: number): Promise<{ moved: number; labelsOnly: boolean }> {
    const folder = this.deps.store.folder(folderId)
    if (!folder) throw Object.assign(new Error('Priečinok neexistuje'), { code: 'NO_TARGET' })
    if (folder.special_use || folder.path.toUpperCase() === 'INBOX') throw Object.assign(new Error('Tento priečinok sa odstrániť nedá'), { code: 'FOLDER_PROTECTED' })
    const s = this.syncs.get(folder.account_id)
    if (!s) throw Object.assign(new Error('Konto neexistuje'), { code: 'NO_ACCOUNT' })
    return s.deleteFolder(folder.path)
  }

  private afterLocalChange(folderIds: number[]): void {
    const unique = [...new Set(folderIds)]
    this.deps.emit('messages.changed', { folderIds: unique })
    const accounts = new Set(unique.map((id) => this.deps.store.folder(id)?.account_id).filter((x): x is number => x !== undefined))
    for (const a of accounts) {
      this.deps.emit('folders.changed', { accountId: a })
      this.syncs.get(a)?.refreshStatus()
    }
  }

  /**
   * Zmena príznakov (prečítané, hviezdička): hneď lokálne, potom na server cez frontu operácií.
   * Ak server práve nie je dostupný, zmena počká a odošle sa pri ďalšej synchronizácii.
   */
  setFlags(ids: number[], change: { seen?: boolean; flagged?: boolean }): void {
    const store = this.deps.store
    const rows = store.setLocalFlags(ids, change)
    const groups = new Map<string, { accountId: number; folderId: number; uids: number[]; messageIds: number[] }>()
    for (const r of rows) {
      const key = `${r.account_id}:${r.folder_id}`
      const g = groups.get(key) ?? { accountId: r.account_id, folderId: r.folder_id, uids: [], messageIds: [] }
      g.uids.push(r.uid)
      g.messageIds.push(r.id)
      groups.set(key, g)
    }
    const add: string[] = []
    const remove: string[] = []
    if (change.seen !== undefined) (change.seen ? add : remove).push('\\Seen')
    if (change.flagged !== undefined) (change.flagged ? add : remove).push('\\Flagged')
    const touched = new Set<number>()
    for (const g of groups.values()) {
      store.enqueueOperation(g.accountId, 'flags', { folderId: g.folderId, uids: g.uids, messageIds: g.messageIds, add, remove })
      touched.add(g.accountId)
    }
    this.deps.emit('messages.changed', { folderIds: [...new Set(rows.map((r) => r.folder_id))] })
    for (const id of touched) {
      this.syncs.get(id)?.refreshStatus()
      void this.syncs.get(id)?.pushOperations().catch(() => {})
    }
  }
}
