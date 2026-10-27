/**
 * Vstupný bod jadra Doar. Beží v Electron utilityProcess (čistý Node.js, bez `electron` importu).
 * Rozhranie sa pripája cez MessagePort, ktorý odovzdá main proces.
 */
import { join } from 'node:path'
import { openDb, sqliteVersion, type Db } from './store/db'
import { BlobStore } from './store/blobs'
import { initLog, logger } from './log'
import { createHandlers, type Handlers } from './handlers'
import { MainSecrets, MemorySecrets } from './secrets'
import { realNet } from './providers/net'
import { MailStore } from './store/mailstore'
import { SyncManager } from './sync/manager'
import { ExportManager } from './export/manager'
import { ImportManager } from './import/manager'
import { ArchiveManager } from './archive/archive'
import { FileGrants, cleanOpenDir } from './files'
import { collectBlobs } from './account-admin'
import { getSettings } from './settings'
import { OAuthService } from './oauth/oauth'
import { ContactSync } from './contact-sync'
import { getAccount } from './accounts'
import type { CoreToMain, MainToCore, PortMessage } from '../shared/ipc'
import { isRequestChannel } from '../shared/ipc'

interface ParentPortLike {
  on(event: 'message', fn: (e: { data: unknown; ports: MessagePortLike[] }) => void): void
  postMessage(msg: unknown): void
}
interface MessagePortLike {
  on(event: 'message', fn: (e: { data: unknown }) => void): void
  on(event: 'close', fn: () => void): void
  postMessage(msg: unknown): void
  start(): void
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
if (!parentPort) throw new Error('Core musí bežať ako Electron utilityProcess')

const log = logger('core')
let handlers: Handlers | null = null
let exports: ExportManager | null = null
let imports: ImportManager | null = null
let archives: ArchiveManager | null = null
let syncManager: SyncManager | null = null
const files = new FileGrants()
const ports = new Set<MessagePortLike>()
const secrets = new MainSecrets((msg: CoreToMain) => parentPort.postMessage(msg))
const sessionSecrets = new MemorySecrets()

/** Pošle udalosť všetkým pripojeným oknám. */
function broadcast(msg: Extract<PortMessage, { kind: 'evt' }>): void {
  for (const p of ports) p.postMessage(msg)
}

function attachPort(port: MessagePortLike): void {
  ports.add(port)
  port.on('close', () => ports.delete(port))
  port.on('message', (e) => {
    const msg = e.data as PortMessage
    if (!msg || msg.kind !== 'req' || typeof msg.id !== 'number') return
    void handleRequest(port, msg)
  })
  port.start()
}

async function handleRequest(port: MessagePortLike, msg: Extract<PortMessage, { kind: 'req' }>): Promise<void> {
  try {
    if (!handlers) throw Object.assign(new Error('Jadro sa ešte inicializuje'), { code: 'NOT_READY' })
    if (!isRequestChannel(msg.ch)) throw Object.assign(new Error('Neznámy kanál'), { code: 'UNKNOWN_CHANNEL' })
    const fn = handlers[msg.ch] as (data: unknown) => unknown
    const data = await fn(msg.data)
    port.postMessage({ kind: 'res', id: msg.id, ok: true, data } satisfies PortMessage)
  } catch (e) {
    const err = e as Error & { code?: string }
    log.warn('požiadavka zlyhala', { ch: msg.ch, code: err.code, error: err })
    port.postMessage({
      kind: 'res',
      id: msg.id,
      ok: false,
      error: { code: err.code ?? 'ERROR', message: err.message }
    } satisfies PortMessage)
  }
}

function init(dataDir: string, appVersion: string): void {
  initLog(dataDir)
  const db: Db = openDb(join(dataDir, 'doar.db'))
  const blobs = new BlobStore(join(dataDir, 'blobs'))
  const store = new MailStore(db)
  const emit: Parameters<typeof createHandlers>[0]['emit'] = (ch, data) => broadcast({ kind: 'evt', ch, data })
  const oauth = new OAuthService({ secrets, sessionSecrets })
  const sync = new SyncManager({
    oauth,
    db,
    store,
    blobs,
    secrets,
    sessionSecrets,
    emit,
    // Nová pošta → systémové oznámenie (zobrazí main proces), ak ho používateľ nevypol.
    onNewMail: ({ messageIds }) => {
      const s = getSettings(db)
      if (!s.notifyNewMail) return
      const newest = messageIds.map((id) => store.message(id)).filter((m): m is NonNullable<typeof m> => m !== null)
        .sort((a, b) => (b.internal_date ?? '').localeCompare(a.internal_date ?? ''))[0]
      if (!newest) return
      parentPort!.postMessage({
        kind: 'newMail',
        accountEmail: newest.account_email,
        count: messageIds.length,
        messageId: newest.id,
        from: s.notifyShowContent ? newest.from_name || newest.from_addr || null : null,
        subject: s.notifyShowContent ? newest.subject : null
      } satisfies CoreToMain)
    }
  })
  exports = new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) })
  imports = new ImportManager({
    db,
    store,
    blobs,
    emit,
    files,
    workDir: join(dataDir, 'import-work'),
    newClient: (id) => sync.newImapClient(id),
    afterImport: (id) => void sync.get(id)?.requestSync().catch(() => {})
  })
  cleanOpenDir(dataDir)
  archives = new ArchiveManager({ db, files, emit })
  void archives.init().catch((e) => log.warn('kontrola archívov zlyhala', { error: e }))
  // Adresár: synchronizácia s kontaktmi Google (ak ju používateľ zapol).
  const contactSync = new ContactSync({
    db,
    emit,
    token: (id) => oauth.accessToken(id, getAccount(db, id).passwordStorage),
    invalidate: (id) => oauth.invalidate(id),
    discoveryUrl: process.env['DOAR_CARDDAV_TEST_URL'] ? () => process.env['DOAR_CARDDAV_TEST_URL']! : undefined
  })
  handlers = createHandlers({
    contactSync,
    exports,
    imports,
    archives,
    files,
    db,
    blobs,
    store,
    sync,
    dataDir,
    appVersion,
    sqlite: sqliteVersion(db),
    secrets,
    sessionSecrets,
    net: realNet,
    oauth,
    emit
  })
  log.info('jadro pripravené', { node: process.versions.node, sqlite: sqliteVersion(db) })
  parentPort!.postMessage({ kind: 'ready' } satisfies CoreToMain)
  syncManager = sync
  sync.startAll()
  contactSync.schedule()
  // Upratanie úložiska originálov chvíľu po štarte (nič neblokuje).
  setTimeout(() => collectBlobs({ store, blobs }), 60_000).unref?.()
}

parentPort.on('message', (e) => {
  const msg = e.data as MainToCore | { kind: 'port' }
  if (msg.kind === 'init') {
    try {
      init(msg.dataDir, msg.appVersion)
    } catch (err) {
      log.error('inicializácia jadra zlyhala', { error: err })
      process.exit(1)
    }
  } else if (msg.kind === 'port') {
    const p = e.ports[0]
    if (p) attachPort(p)
  } else if (msg.kind === 'export.allow') {
    exports?.allow(msg.path)
  } else if (msg.kind === 'reconnect') {
    syncManager?.reconnectAll()
  } else if (msg.kind === 'files.allow') {
    if (msg.mode === 'read' || msg.mode === 'write' || msg.mode === 'dir' || msg.mode === 'tree') files.allow(msg.path, msg.mode)
  } else if (msg.kind === 'secret.result') {
    secrets.resolve(msg)
  }
})

process.on('uncaughtException', (err) => log.error('neošetrená výnimka', { error: err }))
process.on('unhandledRejection', (err) => log.error('neošetrené odmietnutie', { error: err }))
