import type { FolderInfo, FolderRow, HeaderInput, OutboxRow } from '../store/mailstore'
import type { SpecialUse, SyncStatus } from '../../shared/ipc'
import { OFFLINE_CODES } from '../../shared/ipc'
import { GraphClient, type GraphError, type GraphFetch } from '../graph/client'
import { indexInfo } from '../mail/parse'
import { buildDraftRaw } from '../drafts'
import { logger } from '../log'
import type { AccountRow, MovePayload, SyncDeps } from './account-sync'
import { DEFAULT_NAMES } from './account-sync'

const log = logger('graph-sync')

/**
 * Synchronizácia konta cez Microsoft Graph (Outlook.com, Hotmail, Microsoft 365) – rovnaké rozhranie ako
 * IMAP (AccountSync), iný prenos:
 * - priečinky: zoznam /me/mailFolders (cesta v databáze = ID priečinka v Graph),
 * - správy: „delta“ priečinka (len zmeny od minule), originál správy (.eml) cez /$value,
 * - zmeny: PATCH (prečítané, hviezdička), /move, DELETE, koncept = správa v MIME do Konceptov,
 * - odoslanie: /sendMail s celou správou v MIME (server sám uloží kópiu do Odoslaných),
 * - nová pošta: doručená pošta sa kontroluje každú minútu (Graph neponúka IDLE pre desktop).
 * ID správ sú nemenné (ImmutableId) – platia aj po presune.
 */

const SELECT = 'subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,isDraft,flag,internetMessageId,hasAttachments'
const WELL_KNOWN: [SpecialUse, string][] = [
  ['inbox', 'inbox'],
  ['sent', 'sentitems'],
  ['drafts', 'drafts'],
  ['trash', 'deleteditems'],
  ['junk', 'junkemail'],
  ['archive', 'archive']
]
/** Priečinky, ktoré sa nezobrazujú (Pošta na odoslanie Outlooku – Doar má vlastnú frontu). */
const HIDDEN_WELL_KNOWN = ['outbox']
/** Odmietnutá požiadavka používateľa – rozhranie ju ukáže, stav synchronizácie sa nemení. */
const USER_ERRORS = ['FOLDER_EXISTS', 'FOLDER_PROTECTED', 'FOLDER_INTO_ITSELF', 'INVALID_FOLDER_NAME', 'NO_TARGET', 'NOT_FOUND', 'REJECTED']
const BODY_CHUNK = 10
const PERIODIC_MS = 5 * 60_000
const INBOX_POLL_MS = 60_000
const MAX_BACKOFF_MS = 5 * 60_000
/** Graph prijme požiadavku najviac do 4 MB; MIME ide v base64 (+33 %). */
const MAX_MIME_BYTES = Math.floor((4 * 1024 * 1024 * 3) / 4) - 16 * 1024

interface GraphMessage {
  id: string
  subject?: string | null
  from?: { emailAddress?: { name?: string; address?: string } } | null
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[]
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[]
  receivedDateTime?: string | null
  sentDateTime?: string | null
  isRead?: boolean
  isDraft?: boolean
  flag?: { flagStatus?: string } | null
  internetMessageId?: string | null
  '@removed'?: { reason?: string }
}

interface GraphFolder {
  id: string
  displayName: string
  parentFolderId?: string
  childFolderCount?: number
}

const iso = (d: string | null | undefined): string | null => {
  if (!d) return null
  const x = new Date(d)
  return Number.isNaN(x.getTime()) ? null : x.toISOString()
}
const addrs = (l?: { emailAddress?: { name?: string; address?: string } }[]): { name: string; address: string }[] =>
  (l ?? []).map((r) => r.emailAddress ?? {}).filter((a) => a.address).map((a) => ({ name: a.name ?? '', address: a.address! }))
/** Hodnota do $filter: apostrof sa zdvojí. */
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
const enc = encodeURIComponent

function flagSet(m: GraphMessage, answered: boolean): Set<string> {
  const s = new Set<string>()
  if (m.isRead) s.add('\\Seen')
  if (m.flag?.flagStatus === 'flagged') s.add('\\Flagged')
  if (m.isDraft) s.add('\\Draft')
  // Graph „odpovedané“ nepozná – Doar si ho pamätá sám (inak by ho každá zmena zo servera zmazala).
  if (answered) s.add('\\Answered')
  return s
}

function header(m: GraphMessage, uid: number): HeaderInput {
  const from = m.from?.emailAddress
  return {
    uid,
    size: 0,
    internalDate: iso(m.receivedDateTime),
    dateHeader: iso(m.sentDateTime),
    messageId: m.internetMessageId ?? null,
    inReplyTo: null,
    subject: m.subject ?? '',
    fromAddr: from?.address ?? '',
    fromName: from?.name ?? '',
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    flags: flagSet(m, false),
    remoteId: m.id
  }
}

function isDue(r: OutboxRow, now: number): boolean {
  return !r.send_at || !(Date.parse(r.send_at) > now)
}

type Task = { prio: number; key: string; run: () => Promise<void>; done: (e?: unknown) => void }

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export class GraphSync {
  private graph: GraphClient
  private tasks: Task[] = []
  private running = false
  private stopped = false
  private timers = new Set<NodeJS.Timeout>()
  private backoff = 0
  private retryTimer: NodeJS.Timeout | null = null
  private missingBodies = new Set<number>()
  /** ID špeciálnych priečinkov v Graph (nemenia sa). */
  private wellKnown: Map<string, SpecialUse> | null = null
  private hiddenIds = new Set<string>()
  status: SyncStatus

  constructor(
    private account: AccountRow,
    private deps: SyncDeps & { graphBase?: string; graphFetch?: GraphFetch }
  ) {
    this.graph = new GraphClient(
      async (o) => {
        if (o?.fresh) this.deps.onAuthRejected?.(this.account)
        const c = await this.deps.getPassword(this.account)
        if (!c || typeof c === 'string') throw err('OAUTH_EXPIRED', 'Chýba prihlásenie')
        return c.accessToken
      },
      { base: deps.graphBase, fetch: deps.graphFetch }
    )
    this.status = {
      accountId: account.id,
      state: 'idle',
      pendingBodies: deps.store.countNeedingBodies(account.id),
      pendingChanges: deps.store.countPendingChanges(account.id),
      lastSync: null
    }
  }

  get id(): number {
    return this.account.id
  }

  start(): void {
    this.stopped = false
    void this.processOutboxNow().catch(() => {})
    void this.pushOperations().catch(() => {})
    void this.requestSync().catch(() => {})
    this.timers.add(setInterval(() => void this.requestSync().catch(() => {}), PERIODIC_MS))
    this.timers.add(setInterval(() => void this.requestInboxSync().catch(() => {}), INBOX_POLL_MS))
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const task of this.tasks) task.done(new Error('STOPPED'))
    this.tasks = []
  }

  requestSync(): Promise<void> {
    return this.enqueue('full', 5, () => this.fullSync())
  }

  fetchBodyNow(messageId: number): Promise<void> {
    return this.enqueue(`body:${messageId}`, 0, () => this.fetchBodies([messageId]))
  }

  pushOperations(): Promise<void> {
    return this.enqueue('ops', 1, () => this.processOperations())
  }

  processOutboxNow(): Promise<void> {
    return this.enqueue('outbox', 1, () => this.processOutbox())
  }

  refreshStatus(): void {
    this.setStatus({})
  }

  reconnectNow(): void {
    if (this.stopped) return
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.timers.delete(this.retryTimer)
      this.retryTimer = null
    }
    this.backoff = 0
    void this.requestSync().catch(() => {})
    void this.processOutboxNow().catch(() => {})
  }

  // ---------- fronta úloh (ako pri IMAP: jedna úloha naraz, podľa priority) ----------

  private enqueue(key: string, prio: number, run: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('STOPPED'))
    const existing = this.tasks.find((t) => t.key === key)
    if (existing) {
      return new Promise((resolve, reject) => {
        const prev = existing.done
        existing.done = (e) => {
          prev(e)
          if (e) reject(e)
          else resolve()
        }
      })
    }
    return new Promise((resolve, reject) => {
      this.tasks.push({ prio, key, run, done: (e) => (e ? reject(e) : resolve()) })
      this.tasks.sort((a, b) => a.prio - b.prio)
      void this.loop()
    })
  }

  private async loop(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.tasks.length && !this.stopped) {
        const task = this.tasks.shift()!
        try {
          await task.run()
          this.backoff = 0
          task.done()
        } catch (e) {
          task.done(e)
          // Chyba požiadavky používateľa (napr. priečinok už existuje) nie je výpadok synchronizácie.
          if (!USER_ERRORS.includes((e as { code?: string }).code ?? '')) this.handleError(e)
          // Bez spojenia nemá zvyšok fronty zmysel skúšať – obnoví sa pri ďalšom pokuse.
          if (OFFLINE_CODES.includes((e as { code?: string }).code ?? '') || (e as { code?: string }).code === 'AUTH_FAILED') {
            for (const t of this.tasks) t.done(e)
            this.tasks = []
          }
        }
      }
    } finally {
      this.running = false
    }
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      pendingBodies: this.deps.store.countNeedingBodies(this.account.id),
      pendingChanges: this.deps.store.countPendingChanges(this.account.id)
    }
    this.deps.emit('sync.status', this.status)
  }

  private handleError(e: unknown): void {
    if (this.stopped) return
    const code = (e as { code?: string }).code ?? 'UNKNOWN'
    const offline = OFFLINE_CODES.includes(code)
    ;(this.backoff === 0 && offline ? log.info : log.warn)('synchronizácia prerušená', { account: this.account.id, code, error: e })
    if (code === 'AUTH_FAILED') this.deps.onAuthRejected?.(this.account)
    this.setStatus({ state: offline ? 'offline' : 'error', code })
    if (code === 'PASSWORD_REQUIRED' || code === 'OAUTH_EXPIRED' || code === 'OAUTH_NOT_CONFIGURED' || code === 'GRAPH_MAILBOX' || this.stopped) return
    if (this.retryTimer) return
    this.backoff = this.backoff === 0 ? 1000 : Math.min(Math.max(this.backoff * 2, 15_000), MAX_BACKOFF_MS)
    const t = setTimeout(() => {
      this.timers.delete(t)
      this.retryTimer = null
      void this.requestSync().catch(() => {})
    }, this.backoff)
    this.retryTimer = t
    this.timers.add(t)
  }

  private later(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
    return t
  }

  // ---------- synchronizácia ----------

  private async fullSync(): Promise<void> {
    this.setStatus({ state: 'syncing', code: undefined })
    this.missingBodies.clear()
    await this.processOperations()
    await this.syncFolderList()
    const order: Record<string, number> = { inbox: 0, sent: 1, drafts: 2 }
    const folders = this.deps.store
      .folderRows(this.account.id)
      .sort((a, b) => (order[a.special_use ?? ''] ?? 5) - (order[b.special_use ?? ''] ?? 5))
    for (const f of folders) {
      if (this.stopped) return
      try {
        await this.syncFolder(f)
      } catch (e) {
        const code = (e as { code?: string }).code ?? ''
        if (OFFLINE_CODES.includes(code) || code === 'AUTH_FAILED') throw e
        log.warn('priečinok sa nepodarilo synchronizovať', { account: this.account.id, folder: f.id, code })
      }
    }
    this.setStatus({ state: 'idle', code: undefined, lastSync: new Date().toISOString() })
    if (this.deps.store.outboxRows(this.account.id).some((r) => (r.state === 'queued' && isDue(r, Date.now())) || r.state === 'uncertain')) {
      void this.processOutboxNow().catch(() => {})
    }
    this.scheduleNextSend()
    this.scheduleBodies()
  }

  private requestInboxSync(): Promise<void> {
    return this.enqueue('inbox', 2, async () => {
      const inbox = this.deps.store.specialFolder(this.account.id, 'inbox')
      if (!inbox) return this.fullSync()
      await this.syncFolder(inbox)
      this.setStatus({ state: 'idle', code: undefined, lastSync: new Date().toISOString() })
      this.scheduleBodies()
    })
  }

  private async specialIds(): Promise<Map<string, SpecialUse>> {
    if (this.wellKnown) return this.wellKnown
    const map = new Map<string, SpecialUse>()
    for (const [use, name] of WELL_KNOWN) {
      try {
        map.set((await this.graph.get<{ id: string }>(`/me/mailFolders/${name}?$select=id`)).id, use)
      } catch (e) {
        if ((e as GraphError).code !== 'NOT_FOUND') throw e
      }
    }
    for (const name of HIDDEN_WELL_KNOWN) {
      try {
        this.hiddenIds.add((await this.graph.get<{ id: string }>(`/me/mailFolders/${name}?$select=id`)).id)
      } catch (e) {
        if ((e as GraphError).code !== 'NOT_FOUND') throw e
      }
    }
    this.wellKnown = map
    return map
  }

  /** Strom priečinkov z Graph → lokálne priečinky (cesta = ID; nadradený = ID nadradeného, najvyššia úroveň bez neho). */
  private async syncFolderList(): Promise<void> {
    const special = await this.specialIds()
    const fields = '$select=id,displayName,parentFolderId,childFolderCount&$top=250'
    const top = await this.graph.getAll<GraphFolder>(`/me/mailFolders?${fields}`)
    const all: { f: GraphFolder; parent: string | null }[] = top.map((f) => ({ f, parent: null }))
    for (let i = 0; i < all.length && i < 5000; i++) {
      const { f } = all[i]!
      if ((f.childFolderCount ?? 0) > 0) {
        for (const c of await this.graph.getAll<GraphFolder>(`/me/mailFolders/${enc(f.id)}/childFolders?${fields}`)) all.push({ f: c, parent: f.id })
      }
    }
    const infos: FolderInfo[] = all
      .filter(({ f }) => !this.hiddenIds.has(f.id))
      .map(({ f, parent }) => {
        const use = special.get(f.id) ?? null
        return { path: f.id, delimiter: null, name: f.displayName, parentPath: parent, specialUse: use, specialUseSource: use ? 'server' : null, selectable: true, subscribed: true }
      })
    this.deps.store.syncFolders(this.account.id, infos)
    this.deps.emit('folders.changed', { accountId: this.account.id })
  }

  /** Zmeny v priečinku od minulej synchronizácie (delta). Bez uloženého odkazu – celý priečinok. */
  private async syncFolder(folder: FolderRow, retried = false): Promise<void> {
    const store = this.deps.store
    const current = store.folder(folder.id)
    if (!current) return
    const initial = !current.delta_link
    const known = store.remoteUids(folder.id)
    let maxUid = store.maxUid(folder.id)
    const seen = new Set<string>()
    const removed: string[] = []
    const flags: { uid: number; flags: Set<string> }[] = []
    const arrived: string[] = []
    let next: string | undefined = current.delta_link ?? `/me/mailFolders/${enc(folder.path)}/messages/delta?$select=${SELECT}`
    let deltaLink: string | null = null
    try {
      for (let page = 0; next && page < 10_000; page++) {
        const res = (await this.graph.request('GET', next, { headers: { prefer: 'IdType="ImmutableId", odata.maxpagesize=200' } })).json as {
          value?: GraphMessage[]
          '@odata.nextLink'?: string
          '@odata.deltaLink'?: string
        }
        const headers: HeaderInput[] = []
        for (const m of res.value ?? []) {
          if (m['@removed']) {
            removed.push(m.id)
            continue
          }
          seen.add(m.id)
          const k = known.get(m.id)
          if (k) flags.push({ uid: k.uid, flags: flagSet(m, k.answered) })
          else {
            const h = header(m, ++maxUid)
            known.set(m.id, { uid: h.uid, answered: false })
            headers.push(h)
            arrived.push(m.id)
          }
        }
        if (store.insertHeaders(this.account.id, folder.id, headers) > 0) this.deps.emit('messages.changed', { folderIds: [folder.id] })
        next = res['@odata.nextLink']
        deltaLink = res['@odata.deltaLink'] ?? deltaLink
      }
    } catch (e) {
      // Odkaz na zmeny už neplatí (server ho zahodil) – priečinok sa prejde celý znova.
      const g = e as GraphError
      if (!retried && current.delta_link && (g.code === 'GRAPH_GONE' || /syncstate/i.test(g.graphCode ?? '') || g.status === 400)) {
        log.info('delta odkaz neplatí – priečinok sa načíta celý', { account: this.account.id, folder: folder.id })
        store.setDeltaLink(folder.id, null)
        return this.syncFolder(folder, true)
      }
      throw e
    }
    let changed = store.removeRemote(folder.id, removed) > 0
    // Celé načítanie: čo na serveri nie je, lokálne tiež nemá byť (okrem správ, ktoré sa sem práve presúvajú).
    if (initial) changed = store.removeRemote(folder.id, [...known.keys()].filter((id) => !seen.has(id))) > 0 || changed
    if (store.applyServerFlags(folder.id, flags).length) changed = true
    store.setDeltaLink(folder.id, deltaLink)
    if (changed) this.deps.emit('messages.changed', { folderIds: [folder.id] })

    if (!initial && folder.special_use === 'inbox' && arrived.length) {
      const ids = arrived.map((r) => store.messageByRemote(folder.id, r)).filter((x): x is number => x !== null)
      const handled = this.deps.onArrived?.({ accountId: this.account.id, folderId: folder.id, messageIds: ids }) ?? new Set<number>()
      const unread = ids.filter((id) => !handled.has(id) && store.message(id)?.seen === 0)
      if (unread.length && this.deps.onNewMail) this.deps.onNewMail({ accountId: this.account.id, folderId: folder.id, messageIds: unread })
    }
  }

  private scheduleBodies(): void {
    if (this.stopped) return
    const next = this.deps.store.needingBodies(this.account.id, BODY_CHUNK + this.missingBodies.size).filter((m) => !this.missingBodies.has(m.id))
    if (!next.length) return
    void this.enqueue('bodies', 9, async () => {
      await this.fetchBodies(next.slice(0, BODY_CHUNK).map((m) => m.id))
      this.setStatus({})
      this.scheduleBodies()
    }).catch(() => {})
  }

  private async fetchBodies(ids: number[]): Promise<void> {
    const store = this.deps.store
    const touched = new Set<number>()
    for (const id of ids) {
      const row = store.message(id)
      if (!row || row.blob_sha256 || !row.remote_id) continue
      let raw: Buffer
      try {
        raw = (await this.graph.request('GET', `/me/messages/${enc(row.remote_id)}/$value`, { raw: true })).bytes!
      } catch (e) {
        if ((e as GraphError).code === 'NOT_FOUND') {
          this.missingBodies.add(id)
          continue
        }
        throw e
      }
      const sha = this.deps.blobs.put(raw)
      let info = { snippet: '', hasAttachments: false, bodyText: '' }
      try {
        info = await indexInfo(raw)
      } catch (e) {
        log.warn('správu sa nepodarilo spracovať pre vyhľadávanie', { message: id, error: e })
      }
      store.setBody(id, sha, info)
      touched.add(row.folder_id)
    }
    if (touched.size) this.deps.emit('messages.changed', { folderIds: [...touched] })
  }

  // ---------- špeciálne priečinky a správa priečinkov ----------

  async ensureSpecialFolder(use: 'sent' | 'trash' | 'archive' | 'junk' | 'drafts'): Promise<FolderRow> {
    const store = this.deps.store
    const existing = store.specialFolder(this.account.id, use)
    if (existing) return existing
    // Outlook má všetky okrem Archívu vždy; chýbajúci sa založí s bežným názvom.
    let id: string | null = null
    try {
      id = ((await this.graph.request('POST', '/me/mailFolders', { json: { displayName: DEFAULT_NAMES[use] } })).json as GraphFolder).id
    } catch (e) {
      if ((e as GraphError).code !== 'FOLDER_EXISTS') throw e
    }
    this.wellKnown = null
    await this.syncFolderList()
    const path = id ?? store.listFolders(this.account.id).find((x) => x.parentPath === null && !x.specialUse && x.name.toLowerCase() === DEFAULT_NAMES[use].toLowerCase())?.path
    if (!path || !store.folderRows(this.account.id).some((f) => f.path === path)) throw err('NO_TARGET', 'Priečinok sa nepodarilo založiť')
    store.markSpecialUse(this.account.id, path, use)
    this.deps.emit('folders.changed', { accountId: this.account.id })
    return store.specialFolder(this.account.id, use)!
  }

  private isProtected(path: string): boolean {
    const f = this.deps.store.folderRows(this.account.id).find((x) => x.path === path)
    return !!f?.special_use
  }

  createFolder(parentPath: string | null, name: string): Promise<number> {
    let result = 0
    return this.enqueue(`create:${parentPath ?? ''}/${name}`, 1, async () => {
      const siblings = this.deps.store.listFolders(this.account.id).filter((f) => f.parentPath === parentPath)
      if (siblings.some((f) => f.name.toLowerCase() === name.toLowerCase())) throw err('FOLDER_EXISTS', 'Priečinok už existuje')
      const url = parentPath ? `/me/mailFolders/${enc(parentPath)}/childFolders` : '/me/mailFolders'
      const res = (await this.graph.request('POST', url, { json: { displayName: name } })).json as GraphFolder
      await this.syncFolderList()
      result = this.deps.store.folderRows(this.account.id).find((f) => f.path === res.id)?.id ?? 0
    }).then(() => result)
  }

  /** Premenovanie a/alebo presun pod iný priečinok. ID priečinka (a správ) sa nemení. */
  renameFolder(path: string, parentPath: string | null, name: string): Promise<void> {
    return this.enqueue(`rename:${path}`, 1, async () => {
      await this.processOperations()
      const store = this.deps.store
      const items = store.listFolders(this.account.id)
      const me = items.find((f) => f.path === path)
      if (!me) throw err('NO_TARGET', 'Priečinok neexistuje')
      if (this.isProtected(path)) throw err('FOLDER_PROTECTED', 'Tento priečinok sa nedá premenovať')
      // Nie do seba ani do vlastného podpriečinka.
      for (let p = parentPath, i = 0; p !== null && i < 64; i++) {
        if (p === path) throw err('FOLDER_INTO_ITSELF', 'Priečinok sa nedá presunúť do seba')
        p = items.find((f) => f.path === p)?.parentPath ?? null
      }
      if (items.some((f) => f.path !== path && f.parentPath === parentPath && f.name.toLowerCase() === name.toLowerCase())) throw err('FOLDER_EXISTS', 'Priečinok už existuje')
      if (me.name !== name) await this.graph.request('PATCH', `/me/mailFolders/${enc(path)}`, { json: { displayName: name } })
      if (me.parentPath !== parentPath) await this.graph.request('POST', `/me/mailFolders/${enc(path)}/move`, { json: { destinationId: parentPath ?? 'msgfolderroot' } })
      await this.syncFolderList()
    })
  }

  /** Odstráni priečinok – Outlook ho aj so správami presunie do Odstránenej pošty. */
  deleteFolder(path: string): Promise<{ moved: number; labelsOnly: boolean }> {
    const result = { moved: 0, labelsOnly: false }
    return this.enqueue(`delete:${path}`, 1, async () => {
      await this.processOperations()
      if (this.isProtected(path)) throw err('FOLDER_PROTECTED', 'Tento priečinok sa odstrániť nedá')
      const store = this.deps.store
      const items = store.listFolders(this.account.id)
      const subtree = new Set([path])
      for (let changed = true; changed; ) {
        changed = false
        for (const f of items) if (f.parentPath !== null && subtree.has(f.parentPath) && !subtree.has(f.path)) (subtree.add(f.path), (changed = true))
      }
      if (items.some((f) => subtree.has(f.path) && f.specialUse)) throw err('FOLDER_PROTECTED', 'Tento priečinok sa odstrániť nedá')
      result.moved = items.filter((f) => subtree.has(f.path)).reduce((s, f) => s + f.localCount, 0)
      await this.graph.request('DELETE', `/me/mailFolders/${enc(path)}`)
      await this.syncFolderList()
      const trash = store.specialFolder(this.account.id, 'trash')
      if (trash) {
        store.setDeltaLink(trash.id, null)
        void this.requestSync().catch(() => {})
      }
    }).then(() => result)
  }

  // ---------- lokálne zmeny → server ----------

  private async processOperations(): Promise<void> {
    const store = this.deps.store
    for (const op of store.pendingOperations(this.account.id)) {
      if (this.stopped) return
      if (!store.claimOperation(op.id)) continue
      const touched = new Set<number>()
      try {
        await this.runOperation(op.kind, op.payload, touched)
        store.finishOperation(op.id, true)
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'UNKNOWN'
        if (OFFLINE_CODES.includes(code) || code === 'AUTH_FAILED' || code.startsWith('OAUTH_')) {
          store.releaseOperation(op.id)
          throw e
        }
        log.warn('server odmietol zmenu', { account: this.account.id, kind: op.kind, code })
        store.finishOperation(op.id, false, code)
        if (op.attempts + 1 >= 3) this.giveUp(op.kind, op.payload, touched)
      }
      this.deps.emit('messages.changed', { folderIds: [...touched] })
    }
    this.scheduleDelayedOperations()
    this.setStatus({})
  }

  private delayedTimer: NodeJS.Timeout | null = null

  scheduleDelayedOperations(): void {
    const ms = this.deps.store.nextDelayedOperation(this.account.id)
    if (ms === null || this.stopped) return
    if (this.delayedTimer) clearTimeout(this.delayedTimer)
    this.delayedTimer = this.later(() => {
      this.delayedTimer = null
      void this.pushOperations().catch(() => {})
    }, ms + 50)
  }

  private async runOperation(kind: string, payload: unknown, touched: Set<number>): Promise<void> {
    const store = this.deps.store
    if (kind === 'flags') {
      const p = payload as { folderId: number; messageIds: number[]; add: string[]; remove: string[] }
      touched.add(p.folderId)
      const patch: Record<string, unknown> = {}
      if (p.add.includes('\\Seen')) patch['isRead'] = true
      if (p.remove.includes('\\Seen')) patch['isRead'] = false
      if (p.add.includes('\\Flagged')) patch['flag'] = { flagStatus: 'flagged' }
      if (p.remove.includes('\\Flagged')) patch['flag'] = { flagStatus: 'notFlagged' }
      if (Object.keys(patch).length) {
        for (const id of p.messageIds) {
          const row = store.message(id)
          if (!row?.remote_id) continue
          try {
            await this.graph.request('PATCH', `/me/messages/${enc(row.remote_id)}`, { json: patch })
          } catch (e) {
            if ((e as GraphError).code !== 'NOT_FOUND') throw e // medzitým zmazaná – nič
          }
        }
      }
      store.setLocalState(p.messageIds, 'synced')
    } else if (kind === 'move') {
      const p = payload as MovePayload
      touched.add(p.fromFolderId)
      const target = p.toFolderId ? store.folder(p.toFolderId) : await this.ensureSpecialFolder(p.toSpecial!)
      if (!target) throw err('NO_TARGET', 'Cieľový priečinok neexistuje')
      touched.add(target.id)
      let nextUid = store.maxUid(target.id)
      for (const [i, id] of p.messageIds.entries()) {
        const row = store.message(id)
        // Už presunutá (opakovaný pokus po čiastočnom zlyhaní) alebo medzitým zmazaná.
        if (!row || row.folder_id !== p.fromFolderId || !row.remote_id) continue
        let moved: { id: string }
        try {
          moved = (await this.graph.request('POST', `/me/messages/${enc(row.remote_id)}/move`, { json: { destinationId: target.path } })).json as { id: string }
        } catch (e) {
          if ((e as GraphError).code === 'NOT_FOUND') {
            store.deleteMessages([id])
            continue
          }
          throw e
        }
        store.completeMove([id], [p.uids[i] ?? row.uid], target.id, new Map([[p.uids[i] ?? row.uid, ++nextUid]]))
        if (moved?.id && moved.id !== row.remote_id) store.setRemoteId(id, moved.id)
      }
      this.deps.emit('folders.changed', { accountId: this.account.id })
    } else if (kind === 'expunge') {
      const p = payload as { folderId: number; messageIds: number[] }
      touched.add(p.folderId)
      for (const id of p.messageIds) {
        const row = store.message(id)
        if (row?.remote_id) {
          try {
            await this.graph.request('DELETE', `/me/messages/${enc(row.remote_id)}`)
          } catch (e) {
            if ((e as GraphError).code !== 'NOT_FOUND') throw e
          }
        }
        store.deleteMessages([id])
      }
      this.deps.emit('folders.changed', { accountId: this.account.id })
    } else if (kind === 'draft') {
      // Nová verzia konceptu (MIME → správa v Konceptoch), potom odstránenie predošlých verzií.
      const p = payload as { draftId: number }
      const row = store.draft(p.draftId)
      if (!row || row.deleted || row.account_id !== this.account.id || row.server_rev >= row.rev) return
      const rev = row.rev
      const raw = await buildDraftRaw(store, this.deps.blobs, row, { name: this.account.display_name, address: this.account.email })
      if (raw.length > MAX_MIME_BYTES) throw err('GRAPH_TOO_LARGE', 'Koncept je pre server priveľký')
      const folder = await this.ensureSpecialFolder('drafts')
      touched.add(folder.id)
      const created = (await this.graph.request('POST', '/me/messages', { body: raw.toString('base64'), contentType: 'text/plain' })).json as { id: string }
      const oldUid = row.server_folder_id === folder.id ? row.server_uid : null
      await this.removeDraftCopies(folder, row.message_id, oldUid, created.id)
      await this.syncFolder(folder)
      store.setDraftServer(row.id, folder.id, store.remoteUids(folder.id).get(created.id)?.uid ?? null, rev)
      this.scheduleBodies()
    } else if (kind === 'draftDelete') {
      const p = payload as { draftId: number }
      const row = store.draft(p.draftId)
      if (!row) return
      const folder = row.server_folder_id ? store.folder(row.server_folder_id) : null
      if (folder && folder.account_id === this.account.id) {
        touched.add(folder.id)
        await this.removeDraftCopies(folder, row.message_id, row.server_uid, null)
        await this.syncFolder(folder)
      }
      store.deleteDraft(row.id)
    } else if (kind === 'draftRemove') {
      const p = payload as { folderId: number; messageId: string; uid: number | null }
      const folder = store.folder(p.folderId)
      if (!folder) return
      touched.add(folder.id)
      await this.removeDraftCopies(folder, p.messageId, p.uid, null)
      await this.syncFolder(folder)
    } else {
      throw err('UNKNOWN_OPERATION', 'Neznáma operácia')
    }
  }

  /** Odstráni verzie konceptu v priečinku (podľa Message-ID a známeho uid), okrem `keep` (ID novej verzie). */
  private async removeDraftCopies(folder: FolderRow, messageId: string, knownUid: number | null, keep: string | null): Promise<void> {
    const ids = new Set<string>()
    if (knownUid !== null) {
      const row = this.deps.store.messageByUid(folder.id, knownUid)
      const remote = row !== null ? this.deps.store.message(row)?.remote_id : null
      if (remote) ids.add(remote)
    }
    if (messageId) {
      const found = await this.graph.getAll<{ id: string }>(`/me/mailFolders/${enc(folder.path)}/messages?$filter=internetMessageId eq ${enc(q(messageId))}&$select=id`)
      for (const f of found) ids.add(f.id)
    }
    if (keep) ids.delete(keep)
    for (const id of ids) {
      try {
        await this.graph.request('DELETE', `/me/messages/${enc(id)}`)
      } catch (e) {
        if ((e as GraphError).code !== 'NOT_FOUND') throw e
      }
    }
  }

  private giveUp(kind: string, payload: unknown, touched: Set<number>): void {
    const p = payload as { messageIds?: number[]; folderId?: number; fromFolderId?: number }
    const ids = p.messageIds ?? []
    if (kind === 'move' || kind === 'expunge') this.deps.store.setHidden(ids, false)
    this.deps.store.setLocalState(ids, 'failed')
    const f = p.fromFolderId ?? p.folderId
    if (f) touched.add(f)
  }

  // ---------- odosielanie ----------

  private uncertainChecked = new Set<number>()
  private outboxOffline = false
  private outboxRetry: NodeJS.Timeout | null = null
  private outboxBackoff = 0
  private sendTimer: NodeJS.Timeout | null = null

  private emitOutbox(): void {
    this.deps.emit('outbox.changed', null)
    this.setStatus({})
  }

  private async processOutbox(): Promise<void> {
    const store = this.deps.store
    this.outboxOffline = false
    const now = Date.now()
    for (const r of store.outboxRows(this.account.id).filter((x) => x.state === 'queued' && isDue(x, now))) {
      if (this.stopped || this.outboxOffline) break
      await this.sendOne(r)
    }
    this.scheduleNextSend()
    if (this.outboxOffline) {
      this.setStatus({})
      this.retryOutboxLater()
      return
    }
    // Nejasné odoslanie: ak je správa v Odoslaných, odišla. Inak rozhodne používateľ.
    for (const r of store.outboxRows(this.account.id).filter((x) => x.state === 'uncertain' && !this.uncertainChecked.has(x.id))) {
      this.uncertainChecked.add(r.id)
      try {
        const found = await this.graph.getAll<{ id: string }>(`/me/mailFolders/sentitems/messages?$filter=internetMessageId eq ${enc(q(r.message_id))}&$select=id`)
        if (found.length) {
          store.setOutbox(r.id, { state: 'sent', sentCopyState: 'done', error: null })
          if (r.reply_to_message) this.markAnswered(r.reply_to_message)
          this.emitOutbox()
        }
      } catch (e) {
        if (OFFLINE_CODES.includes((e as { code?: string }).code ?? '')) throw e
      }
    }
    // Kópiu do Odoslaných ukladá server sám – nič nečaká.
    for (const r of store.outboxRows(this.account.id).filter((x) => x.state === 'sent' && (x.sent_copy_state === 'pending' || x.sent_copy_state === 'failed'))) {
      store.setOutbox(r.id, { sentCopyState: 'done' })
    }
  }

  private async sendOne(r: OutboxRow): Promise<void> {
    const store = this.deps.store
    store.setOutbox(r.id, { state: 'sending', error: null, attempt: true })
    this.emitOutbox()
    // Skrytá kópia ostáva v MIME – Graph podľa nej doručí a príjemcom ju nezobrazí.
    const raw = this.deps.blobs.read(r.blob_sha256)
    if (raw.length > MAX_MIME_BYTES) {
      store.setOutbox(r.id, { state: 'error', error: 'GRAPH_TOO_LARGE' })
      log.warn('správa je pre Graph priveľká', { account: this.account.id, outbox: r.id, size: raw.length })
      this.emitOutbox()
      return
    }
    try {
      await this.graph.request('POST', '/me/sendMail', { body: raw.toString('base64'), contentType: 'text/plain' })
      this.outboxBackoff = 0
      store.setOutbox(r.id, { state: 'sent', sentCopyState: 'done', smtpResponse: 'Graph 202', error: null })
      store.rememberAddresses((JSON.parse(r.recipients_json) as string[]).map((address) => ({ name: '', address })))
      if (r.reply_to_message) this.markAnswered(r.reply_to_message)
      log.info('správa odoslaná', { account: this.account.id, outbox: r.id })
      // Kópia v Odoslaných sa načíta pri synchronizácii priečinka.
      const sent = store.specialFolder(this.account.id, 'sent')
      if (sent) this.later(() => void this.enqueue(`folder:${sent.id}`, 3, () => this.syncFolder(sent)).catch(() => {}), 2000)
    } catch (e) {
      const g = e as GraphError
      if ((g.code === 'NO_NETWORK' && !g.uncertain) || g.status === 429 || g.status === 503 || g.code.startsWith('OAUTH_')) {
        // Požiadavka určite nedošla (alebo ju server odmietol pred spracovaním) → zostane vo fronte.
        store.setOutbox(r.id, { state: 'queued', error: g.code.startsWith('OAUTH_') ? g.code : 'OFFLINE' })
        log.info('odoslanie počká', { account: this.account.id, outbox: r.id, code: g.code })
        this.outboxOffline = true
      } else if (g.code === 'NO_NETWORK' || g.code === 'TIMEOUT' || (g.status ?? 0) >= 500) {
        store.setOutbox(r.id, { state: 'uncertain', error: 'UNCERTAIN' })
        log.warn('nejasný výsledok odoslania – správa sa automaticky neopakuje', { account: this.account.id, outbox: r.id, code: g.code })
      } else {
        store.setOutbox(r.id, { state: 'error', error: g.code ?? 'UNKNOWN' })
        log.warn('správu sa nepodarilo odoslať', { account: this.account.id, outbox: r.id, code: g.code, status: g.status })
      }
    }
    this.emitOutbox()
  }

  private scheduleNextSend(): void {
    if (this.sendTimer) {
      clearTimeout(this.sendTimer)
      this.timers.delete(this.sendTimer)
      this.sendTimer = null
    }
    if (this.stopped) return
    const now = Date.now()
    const next = this.deps.store
      .outboxRows(this.account.id)
      .filter((r) => r.state === 'queued' && !isDue(r, now))
      .map((r) => Date.parse(r.send_at!))
      .sort((a, b) => a - b)[0]
    if (next === undefined) return
    this.sendTimer = this.later(() => {
      this.sendTimer = null
      void this.processOutboxNow().catch(() => {})
    }, Math.min(Math.max(next - now, 0) + 500, 2 ** 31 - 1))
  }

  private retryOutboxLater(): void {
    if (this.stopped || this.outboxRetry) return
    this.outboxBackoff = Math.min(Math.max(this.outboxBackoff * 2, 15_000), MAX_BACKOFF_MS)
    this.outboxRetry = this.later(() => {
      this.outboxRetry = null
      void this.processOutboxNow().catch(() => {})
    }, this.outboxBackoff)
  }

  /** Odpovedaná správa: Graph to nepozná – zostáva len v Doare (operácia bez zmeny na serveri). */
  private markAnswered(messageId: number): void {
    const store = this.deps.store
    const row = store.message(messageId)
    if (!row) return
    this.deps.db.prepare('UPDATE messages SET answered = 1 WHERE id = ?').run(messageId)
    this.deps.emit('messages.changed', { folderIds: [row.folder_id] })
  }
}
