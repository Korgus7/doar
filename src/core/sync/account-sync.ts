import type { FetchMessageObject, ImapFlow, ListResponse } from 'imapflow'
import type { Db } from '../store/db'
import type { BlobStore } from '../store/blobs'
import { MailStore, type FolderInfo, type FolderRow, type HeaderInput } from '../store/mailstore'
import type { CoreEvents, EventChannel, SpecialUse, SyncStatus } from '../../shared/ipc'
import { OFFLINE_CODES } from '../../shared/ipc'
import { createImapClient, type Credential } from '../mail/imap'
import { indexInfo } from '../mail/parse'
import { classifyError } from '../mail/connection-test'
import { sendRaw, type SendOutcome } from '../mail/smtp'
import { stripBcc } from '../mail/compose'
import { buildDraftRaw } from '../drafts'
import type { OutboxRow } from '../store/mailstore'
import { logger } from '../log'

const log = logger('sync')

/** Server zmenu odmietol (imapflow vrátil false). Klasifikuje sa ako odmietnutie, nie výpadok spojenia. */
function rejected(what: string): Error {
  return Object.assign(new Error(`Server odmietol zmenu (${what})`), { code: 'REJECTED' })
}

export const DEFAULT_NAMES = { sent: 'Sent', trash: 'Trash', archive: 'Archive', junk: 'Junk', drafts: 'Drafts' } as const

const HEADER_CHUNK = 250
const BODY_CHUNK = 20
const PERIODIC_MS = 5 * 60_000
const MAX_BACKOFF_MS = 5 * 60_000

export interface AccountRow {
  id: number
  email: string
  username: string
  imap_host: string
  imap_port: number
  imap_security: 'tls' | 'starttls'
  smtp_host: string
  smtp_port: number
  smtp_security: 'tls' | 'starttls'
  save_sent_copy: number
  display_name: string
  password_storage: 'os' | 'session'
  auth_type: 'password' | 'oauth2'
}

export interface SyncDeps {
  db: Db
  store: MailStore
  blobs: BlobStore
  /** Heslo, alebo prístupový token (prihlásenie cez účet poskytovateľa). */
  getPassword(account: AccountRow): Promise<Credential | null>
  emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
  /** Pre testy: vlastný klient namiesto skutočného pripojenia. */
  clientFactory?: (account: AccountRow, password: Credential, idle: boolean) => ImapFlow
  /** Pre testy: vlastné odoslanie SMTP. */
  smtpSend?: typeof sendRaw
  /** Server odmietol prístupový token (prihlásenie cez poskytovateľa) – zabudnúť ho. */
  onAuthRejected?: (account: AccountRow) => void
  /** Nové neprečítané správy v doručenej pošte (nie pri prvej synchronizácii). */
  onNewMail?: (n: { accountId: number; folderId: number; messageIds: number[] }) => void
}

const SPECIAL: Record<string, SpecialUse> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
  '\\Important': 'important'
}

export function toFolderInfo(f: ListResponse): FolderInfo {
  const su = f.specialUse ? (SPECIAL[f.specialUse] ?? null) : null
  return {
    path: f.path,
    delimiter: f.delimiter || null,
    name: f.name,
    parentPath: f.parentPath || null,
    specialUse: su,
    specialUseSource: su ? (f.specialUseSource === 'name' ? 'name' : 'server') : null,
    selectable: !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'),
    subscribed: f.subscribed !== false
  }
}

function headerFromFetch(m: FetchMessageObject): HeaderInput {
  const env = m.envelope ?? {}
  const from = env.from?.[0]
  const addr = (l?: { name?: string; address?: string }[]) => (l ?? []).filter((a) => a.address).map((a) => ({ name: a.name ?? '', address: a.address! }))
  const iso = (d: Date | string | undefined | null): string | null => {
    if (!d) return null
    const x = d instanceof Date ? d : new Date(d)
    return Number.isNaN(x.getTime()) ? null : x.toISOString()
  }
  return {
    uid: m.uid,
    size: m.size ?? 0,
    internalDate: iso(m.internalDate),
    dateHeader: iso(env.date),
    messageId: env.messageId ?? null,
    inReplyTo: env.inReplyTo ?? null,
    subject: env.subject ?? '',
    fromAddr: from?.address ?? '',
    fromName: from?.name ?? '',
    to: addr(env.to),
    cc: addr(env.cc),
    flags: m.flags ?? new Set()
  }
}

type Task = { prio: number; key: string; run: () => Promise<void>; done: (e?: unknown) => void }

/**
 * Synchronizácia jedného konta.
 * Jedno pracovné spojenie vykonáva úlohy postupne (prioritná fronta); druhé spojenie sleduje doručenú poštu (IDLE).
 */
export class AccountSync {
  private client: ImapFlow | null = null
  private watcher: ImapFlow | null = null
  private tasks: Task[] = []
  private running = false
  private stopped = false
  private timers = new Set<NodeJS.Timeout>()
  private backoff = 0
  /** Správy, ktoré server pri sťahovaní nevrátil (zmazané medzičasom) – nezacykliť sa. */
  private missingBodies = new Set<number>()
  status: SyncStatus

  constructor(
    private account: AccountRow,
    private deps: SyncDeps
  ) {
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
    void this.startWatcher()
    const t = setInterval(() => void this.requestSync(), PERIODIC_MS)
    this.timers.add(t)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const task of this.tasks) task.done(new Error('STOPPED'))
    this.tasks = []
    const c = this.client
    const w = this.watcher
    this.client = this.watcher = null
    await Promise.allSettled([c?.logout(), w?.logout()])
    c?.close()
    w?.close()
  }

  /** Celková synchronizácia (zlúči sa s už čakajúcou). */
  requestSync(): Promise<void> {
    return this.enqueue('full', 5, () => this.fullSync())
  }

  /** Stiahne originál konkrétnej správy prednostne (používateľ ju práve otvára). */
  fetchBodyNow(messageId: number): Promise<void> {
    return this.enqueue(`body:${messageId}`, 0, () => this.fetchBodies([messageId]))
  }

  /** Odošle čakajúce lokálne zmeny na server. */
  pushOperations(): Promise<void> {
    return this.enqueue('ops', 1, () => this.processOperations())
  }

  // ---------- fronta úloh ----------

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
          this.handleError(e)
          // Pri chybe spojenia zahodíme zvyšok fronty; obnoví sa pri ďalšom pokuse.
          if (!this.client) {
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

  private retryTimer: NodeJS.Timeout | null = null

  /** Sieť je znova dostupná (systém sa prebudil, pripojil k sieti) – skúsiť hneď, nečakať na odklad. */
  reconnectNow(): void {
    if (this.stopped) return
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.timers.delete(this.retryTimer)
      this.retryTimer = null
    }
    if (this.outboxRetry) {
      clearTimeout(this.outboxRetry)
      this.timers.delete(this.outboxRetry)
      this.outboxRetry = null
    }
    this.backoff = 0
    this.outboxBackoff = 0
    void this.requestSync().catch(() => {})
    void this.processOutboxNow().catch(() => {})
    void this.startWatcher()
  }

  private handleError(e: unknown): void {
    if (this.stopped) return // ukončenie aplikácie / odstránenie konta – nie je to chyba
    const own = (e as { code?: string }).code
    const code = own === 'PASSWORD_REQUIRED' || own === 'NO_NETWORK' || own?.startsWith('OAUTH_') ? own : classifyError(e).code
    const oauth = this.account.auth_type === 'oauth2'
    // Server odmietol prístupový token → nabudúce si vypýtať nový (prihlásenie samo nemuselo vypršať).
    if (oauth && code === 'AUTH_FAILED') this.deps.onAuthRejected?.(this.account)
    const offline = OFFLINE_CODES.includes(code ?? '')
    ;(this.backoff === 0 && offline ? log.info : log.warn)('synchronizácia prerušená', { account: this.account.id, code, error: e })
    if (!this.client?.usable || code === 'AUTH_FAILED') {
      try {
        this.client?.close()
      } catch {
        /* ignorovať */
      }
      this.client = null
    }
    this.setStatus({ state: offline ? 'offline' : 'error', code })
    // Zlé heslo nemá zmysel skúšať dookola – počká sa na používateľa.
    if ((code === 'AUTH_FAILED' && !oauth) || code === 'PASSWORD_REQUIRED' || code === 'OAUTH_EXPIRED' || code === 'OAUTH_NOT_CONFIGURED' || code?.startsWith('CERT_') || this.stopped) return
    // Ďalší pokus je už naplánovaný (napr. viac zmien bez pripojenia) – nepridávať ďalšie.
    if (this.retryTimer) return
    // Prvý pokus hneď (server mohol len zavrieť spojenie), potom 15 s, 30 s, … najviac 5 min.
    this.backoff = this.backoff === 0 ? 1000 : Math.min(Math.max(this.backoff * 2, 15_000), MAX_BACKOFF_MS)
    const t = setTimeout(() => {
      this.timers.delete(t)
      this.retryTimer = null
      void this.requestSync().catch(() => {})
    }, this.backoff)
    this.retryTimer = t
    this.timers.add(t)
  }

  private async password(): Promise<Credential> {
    const p = await this.deps.getPassword(this.account)
    if (!p) throw Object.assign(new Error('Chýba heslo'), { code: 'PASSWORD_REQUIRED' })
    return p
  }

  private async newClient(idle: boolean): Promise<ImapFlow> {
    const pass = await this.password()
    return this.deps.clientFactory
      ? this.deps.clientFactory(this.account, pass, idle)
      : createImapClient(
          { host: this.account.imap_host, port: this.account.imap_port, security: this.account.imap_security },
          this.account.username,
          pass,
          { autoIdle: idle }
        )
  }

  private async ensureClient(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    this.client?.close()
    const c = await this.newClient(false)
    await c.connect()
    c.on('close', () => {
      if (this.client === c) this.client = null
    })
    this.client = c
    return c
  }

  // ---------- sledovanie doručenej pošty (IDLE) ----------

  private watcherStarting = false

  private async startWatcher(): Promise<void> {
    // Už beží (alebo sa práve spúšťa) – napr. po „pripojení k sieti“ aj z naplánovaného pokusu.
    if (this.stopped || this.watcher || this.watcherStarting) return
    this.watcherStarting = true
    try {
      const w = await this.newClient(false)
      await w.connect()
      await w.mailboxOpen('INBOX', { readOnly: true })
      this.watcher = w
      log.debug('sledovanie doručenej pošty spustené', { account: this.account.id })
      let debounce: NodeJS.Timeout | null = null
      const onChange = (): void => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => void this.requestInboxSync().catch(() => {}), 400)
      }
      for (const ev of ['exists', 'expunge', 'flags'] as const) {
        w.on(ev, () => {
          log.debug('zmena v doručenej pošte', { account: this.account.id, event: ev })
          onChange()
        })
      }
      w.on('close', () => {
        if (this.watcher === w) this.watcher = null
        if (!this.stopped) this.later(() => void this.startWatcher(), 30_000)
      })
      // IDLE hneď a stále znova: knižnica IDLE po udalosti (napr. zmena príznaku) ukončí a sama ho
      // neobnoví – ďalšia nová správa by sa potom neohlásila.
      void (async () => {
        while (!this.stopped && this.watcher === w && w.usable) {
          try {
            await w.idle()
          } catch (e) {
            log.debug('IDLE skončil chybou', { account: this.account.id, error: e })
            break
          }
          await new Promise((r) => setTimeout(r, 100))
        }
      })()
    } catch (e) {
      log.info('sledovanie doručenej pošty sa nespustilo', { account: this.account.id, code: classifyError(e).code })
      if (!this.stopped) this.later(() => void this.startWatcher(), 60_000)
    } finally {
      this.watcherStarting = false
    }
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
  }

  private requestInboxSync(): Promise<void> {
    return this.enqueue('inbox', 2, async () => {
      const inbox = this.deps.store.folderRows(this.account.id).find((f) => f.special_use === 'inbox')
      if (!inbox) return this.fullSync()
      await this.syncFolder(await this.ensureClient(), inbox)
      this.setStatus({ state: 'idle', code: undefined, lastSync: new Date().toISOString() })
      this.scheduleBodies()
    })
  }

  // ---------- synchronizácia ----------

  /** Odošle čakajúce správy a dokončí kópie do Odoslaných (vysoká priorita). */
  processOutboxNow(): Promise<void> {
    return this.enqueue('outbox', 1, () => this.processOutbox())
  }

  private async fullSync(): Promise<void> {
    const client = await this.ensureClient()
    this.setStatus({ state: 'syncing', code: undefined })
    // Správy, ktorých obsah sa nedal stiahnuť, skúsime po synchronizácii znova (priečinok mohol byť
    // medzitým nahradený a ID riadku použité pre inú správu).
    this.missingBodies.clear()
    await this.processOperations()

    const list = await client.list()
    this.deps.store.syncFolders(this.account.id, list.map(toFolderInfo))
    this.deps.emit('folders.changed', { accountId: this.account.id })

    const order: Record<string, number> = { inbox: 0, sent: 1, drafts: 2 }
    const folders = this.deps.store
      .folderRows(this.account.id)
      .filter((f) => f.selectable)
      .sort((a, b) => (order[a.special_use ?? ''] ?? 5) - (order[b.special_use ?? ''] ?? 5))
    for (const f of folders) {
      if (this.stopped) return
      try {
        await this.syncFolder(client, f)
      } catch (e) {
        // Chyba jedného priečinka (napr. práve zmazaný inde) nezastaví ostatné – pokiaľ spojenie žije.
        if (!client.usable) throw e
        log.warn('priečinok sa nepodarilo synchronizovať', { account: this.account.id, folder: f.id, code: classifyError(e).code })
      }
    }
    this.setStatus({ state: 'idle', code: undefined, lastSync: new Date().toISOString() })
    if (this.deps.store.outboxRows(this.account.id).some((r) => r.state === 'queued' || r.state === 'uncertain' || r.sent_copy_state === 'pending' || r.sent_copy_state === 'failed')) {
      void this.processOutboxNow().catch(() => {})
    }
    this.scheduleBodies()
  }

  // ---------- odosielanie ----------

  private uncertainChecked = new Set<number>()
  private copyAttempts = new Map<number, number>()

  private emitOutbox(): void {
    this.deps.emit('outbox.changed', null)
    this.setStatus({})
  }

  /** Prepočíta čakajúce zmeny a oznámi stav (po lokálnej zmene, ktorá čaká na server). */
  refreshStatus(): void {
    this.setStatus({})
  }

  /** Posledný pokus o odoslanie zlyhal pre nedostupnosť servera – ďalšie správy v tomto kole neskúšať. */
  private outboxOffline = false

  private async processOutbox(): Promise<void> {
    const store = this.deps.store
    // 1. Odoslanie čakajúcich – potrebuje len SMTP (IMAP môže byť nedostupný).
    this.outboxOffline = false
    for (const r of store.outboxRows(this.account.id).filter((x) => x.state === 'queued')) {
      if (this.stopped || this.outboxOffline) break
      await this.sendOne(r)
    }
    if (this.outboxOffline) {
      this.setStatus({})
      this.retryOutboxLater()
      return
    }
    // 2. Kroky, ktoré potrebujú IMAP: overenie nejasných odoslaní a kópie do Odoslaných.
    const rest = store.outboxRows(this.account.id).filter(
      (r) => (r.state === 'uncertain' && !this.uncertainChecked.has(r.id)) || (r.state === 'sent' && (r.sent_copy_state === 'pending' || (r.sent_copy_state === 'failed' && (this.copyAttempts.get(r.id) ?? 0) < 3)))
    )
    if (!rest.length) return
    const client = await this.ensureClient()
    for (const r of rest) {
      if (this.stopped) return
      if (r.state === 'uncertain') await this.resolveUncertain(client, r)
      else await this.appendSentCopy(client, r)
    }
  }

  private async sendOne(r: OutboxRow): Promise<void> {
    const store = this.deps.store
    const a = this.account
    // Stav „odosiela sa“ sa zapíše PRED pripojením – pri páde aplikácie potom vieme, že výsledok je nejasný.
    store.setOutbox(r.id, { state: 'sending', error: null, attempt: true })
    this.emitOutbox()
    let outcome: SendOutcome
    try {
      const pass = await this.password()
      const raw = stripBcc(this.deps.blobs.read(r.blob_sha256))
      const to = JSON.parse(r.recipients_json) as string[]
      outcome = await (this.deps.smtpSend ?? sendRaw)({ host: a.smtp_host, port: a.smtp_port, security: a.smtp_security }, a.username, pass, { from: a.email, to }, raw)
    } catch (e) {
      // Chyba pred pripojením (napr. chýba heslo) – nič neodišlo.
      outcome = { status: 'failed', code: (e as { code?: string }).code ?? 'UNKNOWN', detail: String((e as Error).message ?? e) }
    }
    if (outcome.status === 'sent') {
      this.outboxBackoff = 0
      store.setOutbox(r.id, { state: 'sent', smtpResponse: outcome.response.slice(0, 500), error: outcome.rejected.length ? `REJECTED_SOME:${outcome.rejected.join(',')}`.slice(0, 500) : null })
      store.rememberAddresses((JSON.parse(r.recipients_json) as string[]).map((address) => ({ name: '', address })))
      if (r.reply_to_message) this.markAnswered(r.reply_to_message)
      log.info('správa odoslaná', { account: a.id, outbox: r.id })
    } else if (outcome.status === 'failed' && OFFLINE_CODES.includes(outcome.code)) {
      // Bez pripojenia: správa určite neodišla (chyba pred odoslaním obsahu) → zostane vo fronte a odošle sa sama.
      store.setOutbox(r.id, { state: 'queued', error: 'OFFLINE' })
      log.info('odoslanie počká na pripojenie', { account: a.id, outbox: r.id, code: outcome.code })
      this.outboxOffline = true
    } else if (outcome.status === 'failed') {
      store.setOutbox(r.id, { state: 'error', error: outcome.code })
      log.warn('správu sa nepodarilo odoslať', { account: a.id, outbox: r.id, code: outcome.code, responseCode: (outcome as { responseCode?: number }).responseCode })
    } else {
      store.setOutbox(r.id, { state: 'uncertain', error: 'UNCERTAIN' })
      log.warn('nejasný výsledok odoslania – správa sa automaticky neopakuje', { account: a.id, outbox: r.id })
    }
    this.emitOutbox()
  }

  private outboxRetry: NodeJS.Timeout | null = null
  private outboxBackoff = 0

  /** Bez pripojenia: odoslanie sa zopakuje samo (15 s, 30 s, … najviac 5 min.) – správa určite neodišla. */
  private retryOutboxLater(): void {
    if (this.stopped || this.outboxRetry) return
    this.outboxBackoff = Math.min(Math.max(this.outboxBackoff * 2, 15_000), MAX_BACKOFF_MS)
    const t = setTimeout(() => {
      this.timers.delete(t)
      this.outboxRetry = null
      void this.processOutboxNow().catch(() => {})
    }, this.outboxBackoff)
    this.outboxRetry = t
    this.timers.add(t)
  }

  private markAnswered(messageId: number): void {
    const store = this.deps.store
    const row = store.message(messageId)
    if (!row) return
    this.deps.db.prepare(`UPDATE messages SET answered = 1, local_state = 'pending' WHERE id = ?`).run(messageId)
    store.enqueueOperation(row.account_id, 'flags', { folderId: row.folder_id, uids: [row.uid], messageIds: [row.id], add: ['\\Answered'], remove: [] })
    this.deps.emit('messages.changed', { folderIds: [row.folder_id] })
    void this.pushOperations().catch(() => {})
  }

  /** Priečinok Odoslané – ak na serveri neexistuje, Doar ho založí. */
  private async sentFolder(client: ImapFlow): Promise<FolderRow> {
    return this.ensureSpecialFolder(client, 'sent')
  }

  /** Špeciálny priečinok konta – ak na serveri chýba, Doar ho založí s bežným názvom. */
  async ensureSpecialFolder(client: ImapFlow, use: 'sent' | 'trash' | 'archive' | 'junk' | 'drafts'): Promise<FolderRow> {
    const store = this.deps.store
    const existing = store.specialFolder(this.account.id, use)
    if (existing) return existing
    const path = DEFAULT_NAMES[use]
    try {
      await client.mailboxCreate(path)
    } catch (e) {
      if (!client.usable) throw e // existujúci priečinok je v poriadku
    }
    store.markSpecialUse(this.account.id, path, use)
    this.deps.emit('folders.changed', { accountId: this.account.id })
    return store.specialFolder(this.account.id, use)!
  }

  /** Nový priečinok na serveri (voliteľne vnorený). Vráti jeho ID v lokálnej databáze. */
  createFolder(parentPath: string | null, name: string): Promise<number> {
    let result = 0
    return this.enqueue(`create:${parentPath ?? ''}/${name}`, 1, async () => {
      const client = await this.ensureClient()
      const list = await client.list()
      const delimiter = list.find((f) => f.delimiter)?.delimiter || '/'
      if (name.includes(delimiter)) throw Object.assign(new Error('Názov obsahuje oddeľovač priečinkov'), { code: 'INVALID_FOLDER_NAME' })
      const path = parentPath ? `${parentPath}${delimiter}${name}` : name
      if (list.some((f) => f.path.toLowerCase() === path.toLowerCase())) throw Object.assign(new Error('Priečinok už existuje'), { code: 'FOLDER_EXISTS' })
      try {
        await client.mailboxCreate(path)
      } catch (e) {
        if (!client.usable) throw e
        throw Object.assign(new Error('Server priečinok nevytvoril'), { code: 'FOLDER_CREATE_FAILED', detail: (e as { responseText?: string }).responseText })
      }
      this.deps.store.syncFolders(this.account.id, (await client.list()).map(toFolderInfo))
      this.deps.emit('folders.changed', { accountId: this.account.id })
      result = this.deps.store.folderRows(this.account.id).find((f) => f.path === path)?.id ?? 0
    }).then(() => result)
  }

  /**
   * Premenuje priečinok alebo ho presunie pod iný (aj na najvyššiu úroveň) – IMAP RENAME, podpriečinky idú s ním.
   * Doručenú poštu a špeciálne priečinky (Odoslané, Kôš…) nemení.
   */
  renameFolder(oldPath: string, parentPath: string | null, name: string): Promise<void> {
    return this.enqueue(`rename:${oldPath}`, 1, async () => {
      await this.processOperations()
      const client = await this.ensureClient()
      const list = await client.list()
      const target = list.find((f) => f.path === oldPath)
      if (!target) throw Object.assign(new Error('Priečinok na serveri neexistuje'), { code: 'NO_TARGET' })
      const delimiter = target.delimiter || list.find((f) => f.delimiter)?.delimiter || '/'
      if (name.includes(delimiter)) throw Object.assign(new Error('Názov obsahuje oddeľovač priečinkov'), { code: 'INVALID_FOLDER_NAME' })
      const local = new Map(this.deps.store.folderRows(this.account.id).map((r) => [r.path, r]))
      const subtree = list.filter((f) => f.path === oldPath || f.path.startsWith(`${oldPath}${delimiter}`))
      if (subtree.some((f) => f.path.toUpperCase() === 'INBOX' || !!f.specialUse || !!local.get(f.path)?.special_use)) {
        throw Object.assign(new Error('Tento priečinok sa nedá premenovať'), { code: 'FOLDER_PROTECTED' })
      }
      const newPath = parentPath ? `${parentPath}${delimiter}${name}` : name
      if (newPath === oldPath) return
      if (parentPath !== null && (parentPath === oldPath || parentPath.startsWith(`${oldPath}${delimiter}`))) {
        throw Object.assign(new Error('Priečinok sa nedá presunúť do seba'), { code: 'FOLDER_INTO_ITSELF' })
      }
      if (list.some((f) => f.path !== oldPath && f.path.toLowerCase() === newPath.toLowerCase())) throw Object.assign(new Error('Priečinok už existuje'), { code: 'FOLDER_EXISTS' })
      try {
        await client.mailboxRename(oldPath, newPath)
      } catch (e) {
        if (!client.usable) throw e
        throw Object.assign(new Error('Server priečinok nepremenoval'), { code: 'FOLDER_RENAME_FAILED', detail: (e as { responseText?: string }).responseText })
      }
      this.deps.store.renameFolderTree(this.account.id, oldPath, newPath, delimiter, parentPath, name)
      this.deps.store.syncFolders(this.account.id, (await client.list()).map(toFolderInfo))
      this.deps.emit('folders.changed', { accountId: this.account.id })
    })
  }

  /**
   * Odstráni priečinok aj s podpriečinkami. Správy z nich najprv presunie do Koša a až potom priečinky zmaže
   * (od najhlbšieho). Gmail: priečinky sú štítky – zruší sa len štítok, správy ostanú vo Všetkej pošte.
   * Doručenú poštu, špeciálne priečinky a priečinky, ktoré ich obsahujú, odmietne.
   */
  deleteFolder(path: string): Promise<{ moved: number; labelsOnly: boolean }> {
    const result = { moved: 0, labelsOnly: false }
    return this.enqueue(`delete:${path}`, 1, async () => {
      // Rozpracované zmeny (presuny, príznaky) najprv na server, aby sa nestratili s priečinkom.
      await this.processOperations()
      const client = await this.ensureClient()
      const list = await client.list()
      const target = list.find((f) => f.path === path)
      if (!target) throw Object.assign(new Error('Priečinok na serveri neexistuje'), { code: 'NO_TARGET' })
      const delimiter = target.delimiter || '/'
      const subtree = list.filter((f) => f.path === path || f.path.startsWith(`${path}${delimiter}`))
      const local = new Map(this.deps.store.folderRows(this.account.id).map((r) => [r.path, r]))
      const protectedFolder = subtree.some((f) => f.path.toUpperCase() === 'INBOX' || !!f.specialUse || !!local.get(f.path)?.special_use)
      if (protectedFolder) throw Object.assign(new Error('Tento priečinok sa odstrániť nedá'), { code: 'FOLDER_PROTECTED' })

      result.labelsOnly = client.capabilities.has('X-GM-EXT-1')
      const trash = result.labelsOnly ? null : await this.ensureSpecialFolder(client, 'trash')
      const deepest = [...subtree].sort((a, b) => b.path.split(delimiter).length - a.path.split(delimiter).length)
      try {
        for (const f of deepest) {
          if (trash && !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent')) {
            const lock = await client.getMailboxLock(f.path)
            try {
              const exists = client.mailbox ? client.mailbox.exists : 0
              if (exists > 0) {
                const res = await client.messageMove('1:*', trash.path)
                if (!res) throw rejected('presun do Koša')
                result.moved += exists
              }
            } finally {
              lock.release()
            }
            await client.mailboxClose().catch(() => {})
          }
          try {
            await client.mailboxDelete(f.path)
          } catch (e) {
            if (!client.usable) throw e
            throw Object.assign(new Error('Server priečinok neodstránil'), { code: 'FOLDER_DELETE_FAILED', detail: (e as { responseText?: string }).responseText })
          }
        }
      } finally {
        if (client.usable) {
          this.deps.store.syncFolders(this.account.id, (await client.list()).map(toFolderInfo))
          this.deps.emit('folders.changed', { accountId: this.account.id })
          if (trash) this.deps.emit('messages.changed', { folderIds: [trash.id] })
        }
      }
      // Koš sa načíta pri ďalšej synchronizácii (presunuté správy).
      if (result.moved) void this.requestSync().catch(() => {})
    }).then(() => result)
  }

  private async existsInFolder(client: ImapFlow, path: string, messageId: string): Promise<boolean> {
    const lock = await client.getMailboxLock(path)
    try {
      await client.noop()
      const found = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || []
      return found.length > 0
    } finally {
      lock.release()
    }
  }

  /** Nejasné odoslanie: ak je správa v Odoslaných (server ju uložil sám), bola odoslaná. Inak rozhodne používateľ. */
  private async resolveUncertain(client: ImapFlow, r: OutboxRow): Promise<void> {
    this.uncertainChecked.add(r.id)
    const sent = this.deps.store.folderRows(this.account.id).find((x) => x.special_use === 'sent')
    if (!sent) return
    try {
      if (await this.existsInFolder(client, sent.path, r.message_id)) {
        this.deps.store.setOutbox(r.id, { state: 'sent', sentCopyState: 'done', error: null })
        if (r.reply_to_message) this.markAnswered(r.reply_to_message)
        this.emitOutbox()
      }
    } catch (e) {
      if (!client.usable) throw e
    }
  }

  /** Kópia do Odoslaných – samostatný krok; jej zlyhanie nikdy nespôsobí nové odoslanie adresátom. */
  private async appendSentCopy(client: ImapFlow, r: OutboxRow): Promise<void> {
    const store = this.deps.store
    this.copyAttempts.set(r.id, (this.copyAttempts.get(r.id) ?? 0) + 1)
    try {
      const folder = await this.sentFolder(client)
      if (!(await this.existsInFolder(client, folder.path, r.message_id))) {
        await client.append(folder.path, this.deps.blobs.read(r.blob_sha256), ['\\Seen'], new Date())
      }
      store.setOutbox(r.id, { sentCopyState: 'done' })
      await this.syncFolder(client, store.folder(folder.id)!)
    } catch (e) {
      if (!client.usable) throw e
      store.setOutbox(r.id, { sentCopyState: 'failed', error: `SENT_COPY:${classifyError(e).code}` })
      log.warn('kópiu do Odoslaných sa nepodarilo uložiť', { account: this.account.id, outbox: r.id, error: e })
    }
    this.emitOutbox()
  }

  /** Synchronizuje jeden priečinok: nové správy (od najnovších), zmazané, zmenené príznaky. */
  private async syncFolder(client: ImapFlow, folder: FolderRow): Promise<void> {
    const store = this.deps.store
    const lock = await client.getMailboxLock(folder.path)
    try {
      // Ak bol priečinok už otvorený, server oznamuje nové správy až po ďalšom príkaze –
      // NOOP najprv načíta aktuálny stav, inak by vyhľadávanie novú správu nezahrnulo.
      await client.noop()
      const mb = client.mailbox
      if (!mb) return
      const uidvalidity = Number(mb.uidValidity)
      if (folder.uidvalidity !== null && folder.uidvalidity !== uidvalidity) {
        log.info('zmena UIDVALIDITY – priečinok sa načíta znova', { account: this.account.id, folder: folder.id })
        store.resetFolder(folder.id, uidvalidity)
        folder = { ...folder, uidvalidity, highestmodseq: null, uidnext: null }
      }
      // Upozorniť len na správy, ktoré prišli od minulej synchronizácie doručenej pošty (nie pri prvom načítaní).
      const notifyFrom = folder.special_use === 'inbox' ? folder.uidnext : null
      const arrived: number[] = []

      const serverUids = mb.exists > 0 ? ((await client.search({ all: true }, { uid: true })) || []) : []
      const serverSet = new Set(serverUids)
      const local = store.localUids(folder.id)
      const fresh = serverUids.filter((u) => !local.has(u)).sort((a, b) => b - a)

      let changed = store.removeMissing(folder.id, serverSet) > 0
      for (let i = 0; i < fresh.length; i += HEADER_CHUNK) {
        const chunk = fresh.slice(i, i + HEADER_CHUNK)
        const headers: HeaderInput[] = []
        for await (const m of client.fetch(chunk.join(','), { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })) {
          headers.push(headerFromFetch(m))
        }
        if (store.insertHeaders(this.account.id, folder.id, headers) > 0) {
          this.deps.emit('messages.changed', { folderIds: [folder.id] })
        }
        if (notifyFrom !== null) for (const h of headers) if (h.uid >= notifyFrom && !h.flags.has('\\Seen')) arrived.push(h.uid)
      }
      if (arrived.length && this.deps.onNewMail) {
        const ids = arrived.map((uid) => store.messageByUid(folder.id, uid)).filter((x): x is number => x !== null)
        if (ids.length) this.deps.onNewMail({ accountId: this.account.id, folderId: folder.id, messageIds: ids })
      }

      // Príznaky: s CONDSTORE len zmenené od minulej synchronizácie, inak všetky.
      const modseq = mb.highestModseq
      const known = folder.highestmodseq ? BigInt(folder.highestmodseq) : null
      if (mb.exists > 0 && local.size > 0 && !(modseq !== undefined && known !== null && modseq === known)) {
        const flags: { uid: number; flags: Set<string> }[] = []
        const opts = modseq !== undefined && known !== null ? { uid: true, changedSince: known } : { uid: true }
        for await (const m of client.fetch('1:*', { uid: true, flags: true }, opts)) {
          if (local.has(m.uid)) flags.push({ uid: m.uid, flags: m.flags ?? new Set() })
        }
        if (store.applyServerFlags(folder.id, flags).length) changed = true
      }

      store.updateFolderState(folder.id, {
        uidvalidity,
        uidnext: mb.uidNext,
        highestmodseq: modseq !== undefined ? modseq.toString() : null,
        total: mb.exists
      })
      if (changed) this.deps.emit('messages.changed', { folderIds: [folder.id] })
    } finally {
      lock.release()
    }
  }

  /** Naplánuje sťahovanie originálov po dávkach (nízka priorita – neblokuje čítanie ani zmeny). */
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
    const rows = ids.map((id) => store.message(id)).filter((r): r is NonNullable<typeof r> => !!r && !r.blob_sha256)
    if (!rows.length) return
    const client = await this.ensureClient()
    const byFolder = new Map<number, typeof rows>()
    for (const r of rows) byFolder.set(r.folder_id, [...(byFolder.get(r.folder_id) ?? []), r])
    for (const [folderId, list] of byFolder) {
      const folder = store.folder(folderId)
      if (!folder) continue
      let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>
      try {
        lock = await client.getMailboxLock(folder.path)
      } catch (e) {
        // Priečinok medzitým zmizol alebo bol premenovaný – vyrieši ďalšia synchronizácia.
        if (!client.usable) throw e
        for (const r of list) this.missingBodies.add(r.id)
        continue
      }
      try {
        if (folder.uidvalidity && Number(client.mailbox && client.mailbox.uidValidity) !== folder.uidvalidity) {
          // Priečinok bol na serveri nahradený (iné UIDVALIDITY) – rovnaké UID je iná správa.
          // Nič nesťahujeme; synchronizácia priečinok načíta znova (má prednosť pred sťahovaním obsahu).
          void this.requestSync().catch(() => {})
          continue
        }
        const byUid = new Map(list.map((r) => [r.uid, r]))
        const seen = new Set<number>()
        for await (const m of client.fetch(list.map((r) => r.uid).join(','), { uid: true, source: true }, { uid: true })) {
          const row = byUid.get(m.uid)
          if (!row || !m.source) continue
          seen.add(m.uid)
          const sha = this.deps.blobs.put(m.source)
          let info = { snippet: '', hasAttachments: false, bodyText: '' }
          try {
            info = await indexInfo(m.source)
          } catch (e) {
            log.warn('správu sa nepodarilo spracovať pre vyhľadávanie', { message: row.id, error: e })
          }
          store.setBody(row.id, sha, info)
        }
        for (const r of list) if (!seen.has(r.uid)) this.missingBodies.add(r.id)
      } finally {
        lock.release()
      }
      this.deps.emit('messages.changed', { folderIds: [folderId] })
    }
  }

  /** Lokálne zmeny (príznaky, presuny, mazanie) → server. */
  private async processOperations(): Promise<void> {
    const store = this.deps.store
    const ops = store.pendingOperations(this.account.id)
    if (ops.length) {
      const client = await this.ensureClient()
      for (const op of ops) {
        if (this.stopped) return
        // Medzitým zrušená cez „Vrátiť späť“ → preskočiť.
        if (!store.claimOperation(op.id)) continue
        const touched = new Set<number>()
        try {
          await this.runOperation(client, op.kind, op.payload, touched)
          store.finishOperation(op.id, true)
        } catch (e) {
          if (!client.usable) {
            store.releaseOperation(op.id)
            throw e
          }
          const code = classifyError(e).code
          log.warn('server odmietol zmenu', { account: this.account.id, kind: op.kind, code })
          store.finishOperation(op.id, false, code)
          if (op.attempts + 1 >= 3) this.giveUp(op.kind, op.payload, touched)
        }
        this.deps.emit('messages.changed', { folderIds: [...touched] })
      }
    }
    this.scheduleDelayedOperations()
    this.setStatus({})
  }

  private delayedTimer: NodeJS.Timeout | null = null

  /** Odložené operácie (čas na „Vrátiť späť“) sa spustia, keď uplynie ich čas. */
  scheduleDelayedOperations(): void {
    const ms = this.deps.store.nextDelayedOperation(this.account.id)
    if (ms === null || this.stopped) return
    if (this.delayedTimer) clearTimeout(this.delayedTimer)
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (this.delayedTimer === t) this.delayedTimer = null
      void this.pushOperations().catch(() => {})
    }, ms + 50)
    this.delayedTimer = t
    this.timers.add(t)
  }

  private async runOperation(client: ImapFlow, kind: string, payload: unknown, touched: Set<number>): Promise<void> {
    const store = this.deps.store
    if (kind === 'flags') {
      const p = payload as { folderId: number; uids: number[]; messageIds: number[]; add: string[]; remove: string[] }
      touched.add(p.folderId)
      const folder = store.folder(p.folderId)
      if (!folder) return
      const lock = await client.getMailboxLock(folder.path)
      try {
        const range = p.uids.join(',')
        // imapflow pri odmietnutí servera nevyhodí chybu, ale vráti false – nesmie sa to brať ako úspech.
        if (p.add.length && (await client.messageFlagsAdd(range, p.add, { uid: true })) === false) throw rejected('príznaky')
        if (p.remove.length && (await client.messageFlagsRemove(range, p.remove, { uid: true })) === false) throw rejected('príznaky')
      } finally {
        lock.release()
      }
      store.setLocalState(p.messageIds, 'synced')
    } else if (kind === 'move') {
      const p = payload as MovePayload
      touched.add(p.fromFolderId)
      const from = store.folder(p.fromFolderId)
      if (!from) return
      const target = p.toFolderId ? store.folder(p.toFolderId) : await this.ensureSpecialFolder(client, p.toSpecial!)
      if (!target) throw Object.assign(new Error('Cieľový priečinok neexistuje'), { code: 'NO_TARGET' })
      touched.add(target.id)
      const lock = await client.getMailboxLock(from.path)
      let uidMap: Map<number, number> | undefined
      try {
        const res = await client.messageMove(p.uids.join(','), target.path, { uid: true })
        // false = server presun odmietol (napr. cieľ medzitým zmazaný) – správa zostala v pôvodnom priečinku.
        if (!res) throw rejected('presun')
        uidMap = res.uidMap
      } finally {
        lock.release()
      }
      store.completeMove(p.messageIds, p.uids, target.id, uidMap)
      this.deps.emit('folders.changed', { accountId: this.account.id })
    } else if (kind === 'expunge') {
      const p = payload as { folderId: number; uids: number[]; messageIds: number[] }
      touched.add(p.folderId)
      const folder = store.folder(p.folderId)
      if (!folder) return
      const lock = await client.getMailboxLock(folder.path)
      try {
        if ((await client.messageDelete(p.uids.join(','), { uid: true })) === false) throw rejected('vymazanie')
      } finally {
        lock.release()
      }
      store.deleteMessages(p.messageIds)
      this.deps.emit('folders.changed', { accountId: this.account.id })
    } else if (kind === 'draft') {
      // Nahratie konceptu: nová verzia do Konceptov, potom odstránenie predošlých verzií.
      const p = payload as { draftId: number }
      const row = store.draft(p.draftId)
      if (!row || row.deleted || row.account_id !== this.account.id || row.server_rev >= row.rev) return
      const rev = row.rev
      const raw = await buildDraftRaw(store, this.deps.blobs, row, { name: this.account.display_name, address: this.account.email })
      const folder = await this.ensureSpecialFolder(client, 'drafts')
      touched.add(folder.id)
      const res = await client.append(folder.path, raw, ['\\Draft', '\\Seen'], new Date())
      const newUid = res && typeof res === 'object' && typeof res.uid === 'number' ? res.uid : null
      const oldUid = row.server_folder_id === folder.id ? row.server_uid : null
      const kept = await this.removeDraftCopies(client, folder.path, row.message_id, oldUid, newUid ?? 'newest')
      store.setDraftServer(row.id, folder.id, kept, rev)
      await this.syncFolder(client, store.folder(folder.id)!)
      this.scheduleBodies()
    } else if (kind === 'draftDelete') {
      // Zahodený alebo odoslaný koncept: preč zo servera, potom aj lokálny záznam.
      const p = payload as { draftId: number }
      const row = store.draft(p.draftId)
      if (!row) return
      const folder = row.server_folder_id ? store.folder(row.server_folder_id) : null
      if (folder && folder.account_id === this.account.id) {
        touched.add(folder.id)
        await this.removeDraftCopies(client, folder.path, row.message_id, row.server_uid, null)
        await this.syncFolder(client, folder)
      }
      store.deleteDraft(row.id)
    } else if (kind === 'draftRemove') {
      // Koncept sa presunul na iné konto – kópia v Konceptoch tohto konta už nepatrí.
      const p = payload as { folderId: number; messageId: string; uid: number | null }
      const folder = store.folder(p.folderId)
      if (!folder) return
      touched.add(folder.id)
      await this.removeDraftCopies(client, folder.path, p.messageId, p.uid, null)
      await this.syncFolder(client, folder)
    } else {
      throw Object.assign(new Error('Neznáma operácia'), { code: 'UNKNOWN_OPERATION' })
    }
  }

  /**
   * Odstráni verzie konceptu v priečinku (podľa Message-ID a známeho UID). Ponechá `keep` –
   * UID práve nahratej verzie, alebo 'newest' (server bez UIDPLUS: najnovšia nájdená). Vráti UID ponechanej verzie.
   */
  private async removeDraftCopies(client: ImapFlow, path: string, messageId: string, knownUid: number | null, keep: number | 'newest' | null): Promise<number | null> {
    const lock = await client.getMailboxLock(path)
    try {
      await client.noop()
      const found = messageId ? (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || [] : []
      const uids = new Set<number>(found)
      if (knownUid) uids.add(knownUid)
      let kept: number | null = null
      if (keep === 'newest') kept = found.length ? Math.max(...found) : null
      else if (typeof keep === 'number') kept = keep
      if (kept !== null) uids.delete(kept)
      if (uids.size) await client.messageDelete([...uids].join(','), { uid: true })
      return kept
    } finally {
      lock.release()
    }
  }

  /** Server zmenu opakovane odmietol – správy sa znova zobrazia a označia ako neúspešné. */
  private giveUp(kind: string, payload: unknown, touched: Set<number>): void {
    const p = payload as { messageIds?: number[]; folderId?: number; fromFolderId?: number }
    const ids = p.messageIds ?? []
    if (kind === 'move' || kind === 'expunge') this.deps.store.setHidden(ids, false)
    this.deps.store.setLocalState(ids, 'failed')
    const f = p.fromFolderId ?? p.folderId
    if (f) touched.add(f)
  }
}

export interface MovePayload {
  fromFolderId: number
  uids: number[]
  messageIds: number[]
  /** Konkrétny cieľový priečinok, alebo špeciálny, ktorý sa v prípade potreby založí. */
  toFolderId?: number
  toSpecial?: 'trash' | 'archive' | 'junk'
}
