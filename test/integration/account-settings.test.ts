import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'
import { createHandlers, type Handlers } from '../../src/core/handlers'
import { FileGrants } from '../../src/core/files'
import { ExportManager } from '../../src/core/export/manager'
import { ImportManager } from '../../src/core/import/manager'
import { ArchiveManager } from '../../src/core/archive/archive'
import { collectBlobs } from '../../src/core/account-admin'

const srv = inject('testserver')
const USER = 'tomas@doar.test'
const OTHER = 'urban@doar.test'

let db: Db
let store: MailStore
let blobs: BlobStore
let sync: SyncManager
let h: Handlers
let dir: string
let accountId: number
let otherId: number
const notices: { accountId: number; messageIds: number[] }[] = []

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

const msg = (to: string, subject: string) =>
  Buffer.from(`From: Ján <jan@firma.sk>\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\n\r\nText\r\n`)

async function append(user: string, subject: string, flags: string[] = []): Promise<void> {
  const c = imap(user)
  await c.connect()
  await c.append('INBOX', msg(user, subject), flags)
  await c.logout()
}

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

const blobFiles = (): number => {
  let n = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : n++
  }
  walk(join(dir, 'blobs'))
  return n
}

const settingsFor = (email: string) => ({
  email, displayName: 'Tomáš', username: email,
  imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' as const },
  smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' as const },
  saveSentCopy: true, providerKey: null
})

beforeAll(async () => {
  await append(USER, 'Stará správa 1')
  await append(USER, 'Stará správa 2')
  await append(OTHER, 'Urbanova správa')
  dir = mkdtempSync(join(tmpdir(), 'doar-accset-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  const session = new MemorySecrets()
  accountId = (await addAccount(db, secrets, session, { settings: settingsFor(USER), password: srv.password, rememberPassword: true })).id
  otherId = (await addAccount(db, secrets, session, { settings: settingsFor(OTHER), password: srv.password, rememberPassword: true })).id
  const emit = () => {}
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: session, emit, onNewMail: (n) => void notices.push(n) })
  h = createHandlers({
    files: new FileGrants(), db, blobs, store, sync, secrets, sessionSecrets: session, emit,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }),
    imports: new ImportManager({ db, store, blobs, emit, files: new FileGrants(), newClient: (id) => sync.newImapClient(id) }),
    archives: new ArchiveManager({ db, files: new FileGrants(), emit }),
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  sync.startAll()
  for (const id of [accountId, otherId]) await until(() => sync.get(id)!.status.lastSync !== null && store.countNeedingBodies(id) === 0)
})

afterAll(async () => {
  await sync?.stopAll()
})

describe('nastavenia konta', () => {
  it('meno, názov, farba, podpis, kópia v Odoslaných', async () => {
    const r = await h['accounts.update']({ id: accountId, patch: { displayName: 'Tomáš Kováč', name: 'Práca', color: '#2F9E44', signature: 'S pozdravom\r\nTomáš Kováč\r\n\r\n', saveSentCopy: false } })
    expect(r).toMatchObject({ name: 'Práca', color: '#2f9e44', displayName: 'Tomáš Kováč', signature: 'S pozdravom\nTomáš Kováč' })
    const d = await h['accounts.get']({ id: accountId })
    expect(d.saveSentCopy).toBe(false)
    expect(d.imap).toEqual({ host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' })
    expect(d.passwordStorage).toBe('os')
    expect(JSON.stringify(d)).not.toContain(srv.password) // heslo sa nikdy nevracia
    await expect(h['accounts.update']({ id: accountId, patch: { color: 'red' } })).rejects.toMatchObject({ code: 'INVALID_COLOR' })
    await expect(h['accounts.update']({ id: accountId, patch: { name: '  ' } })).rejects.toMatchObject({ code: 'INVALID_NAME' })
    expect((await h['accounts.list']()).find((a) => a.id === accountId)?.signature).toBe('S pozdravom\nTomáš Kováč')
  })

  it('server: zlé nastavenia sa neuložia; dobré sa uložia a synchronizácia pokračuje', async () => {
    const before = await h['accounts.get']({ id: accountId })
    const bad = await h['accounts.updateServer']({ id: accountId, username: USER, imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' }, smtp: before.smtp, password: 'zle-heslo' })
    expect(bad.saved).toBe(false)
    expect(bad.test.imap.code).toBe('AUTH_FAILED')
    expect(await h['accounts.get']({ id: accountId })).toEqual(before)

    // Prechod na STARTTLS (port 143) bez zadania hesla – použije sa uložené.
    const ok = await h['accounts.updateServer']({ id: accountId, username: USER, imap: { host: '127.0.0.1', port: srv.ports.imap, security: 'starttls' }, smtp: before.smtp })
    expect(ok.saved).toBe(true)
    expect((await h['accounts.get']({ id: accountId })).imap).toEqual({ host: '127.0.0.1', port: srv.ports.imap, security: 'starttls' })
    await until(() => sync.get(accountId)?.status.state === 'idle' && sync.get(accountId)!.status.lastSync !== null)
  })

  it('nová pošta: upozornenie len na nové neprečítané (nie pri prvom načítaní, nie na prečítané)', async () => {
    expect(notices).toEqual([]) // staré správy pri pridaní konta
    await append(USER, 'Prečítaná inde', ['\\Seen'])
    await append(USER, 'Nová správa')
    await until(() => notices.length > 0, 30_000)
    await new Promise((r) => setTimeout(r, 1000))
    const ids = notices.flatMap((n) => n.messageIds)
    expect(ids.map((id) => store.message(id)?.subject)).toEqual(['Nová správa'])
    expect(notices.every((n) => n.accountId === accountId)).toBe(true)
  })

  it('všeobecné nastavenia: predvolené, uloženie, neplatné hodnoty sa ignorujú', async () => {
    expect(await h['settings.get']()).toEqual({ notifyNewMail: true, notifyShowContent: true, composeHtml: true, threads: false })
    expect(await h['settings.set']({ notifyShowContent: false })).toEqual({ notifyNewMail: true, notifyShowContent: false, composeHtml: true, threads: false })
    expect(await h['settings.set']({ notifyNewMail: 'nie' as unknown as boolean, iné: 1 } as never)).toEqual({ notifyNewMail: true, notifyShowContent: false, composeHtml: true, threads: false })
  })

  it('odstránenie konta: preč z Doaru aj s lokálnou kópiou, pošta na serveri zostane, iné konto nedotknuté', async () => {
    const filesBefore = blobFiles()
    expect(filesBefore).toBeGreaterThan(0)
    await h['accounts.remove']({ id: accountId })
    expect((await h['accounts.list']()).map((a) => a.id)).toEqual([otherId])
    expect(sync.get(accountId)).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) AS c FROM messages WHERE account_id = ?').get(accountId) as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS c FROM folders WHERE account_id = ?').get(accountId) as { c: number }).c).toBe(0)
    // Na serveri všetko zostalo.
    const c = imap(USER)
    await c.connect()
    const st = await c.status('INBOX', { messages: true })
    await c.logout()
    expect((st as { messages: number }).messages).toBe(4)
    // Originály odstráneného konta zmiznú, druhého konta zostanú.
    collectBlobs({ store, blobs }, 0)
    expect(blobFiles()).toBeLessThan(filesBefore)
    const inbox = store.listFolders(otherId).find((f) => f.specialUse === 'inbox')!
    const other = store.listMessages(inbox.id, 0, 10).items[0]!
    expect((await h['messages.get']({ id: other.id })).text).toContain('Text')
    await expect(h['accounts.get']({ id: accountId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
