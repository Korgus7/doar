import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'
import { ExportManager } from '../../src/core/export/manager'
import { rescueMessages, type RescueResult } from '../../src/core/export/rescue'
import { splitMboxrd, stripDoarBlock } from '../../src/core/export/mboxrd'
import type { ExportSummary } from '../../src/shared/ipc'

const srv = inject('testserver')
const USER = 'zachrana@doar.test'

let db: Db
let store: MailStore
let blobs: BlobStore
let sync: SyncManager
let other: ImapFlow
let accountId: number
let dir: string
const rescued: RescueResult[] = []
const calls: { folderPath: string; count: number }[] = []
let failRescue = false

const imap = () =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user: USER, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

const msg = (subject: string): Buffer =>
  Buffer.from(`From: Jan <jan@firma.sk>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@firma.sk>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText: ${subject}\r\n`)

async function until(fn: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

const folder = (p: string) => store.listFolders(accountId).find((f) => f.path === p)
const localCount = (p: string) => (folder(p) ? store.folderMessageIds(folder(p)!.id).length : 0)

/** Synchronizácia teraz a počkať, kým dobehne (nový lastSync). */
async function syncNow(): Promise<void> {
  const before = sync.get(accountId)!.status.lastSync
  await sync.get(accountId)!.requestSync()
  await until(() => sync.get(accountId)!.status.lastSync !== before)
}

const entriesOf = (path: string) => splitMboxrd(readFileSync(path)).map((e) => stripDoarBlock(e.message))

beforeAll(async () => {
  other = imap()
  await other.connect()
  for (let i = 1; i <= 25; i++) await other.append('INBOX', msg(`Doručená ${i}`), ['\\Seen'])
  await other.mailboxCreate('Projekt')
  for (let i = 1; i <= 6; i++) await other.append('Projekt', msg(`Projekt ${i}`), i === 1 ? ['\\Seen', '\\Flagged'] : [])
  await other.mailboxCreate('Staré')
  for (let i = 1; i <= 5; i++) await other.append('Staré', msg(`Staré ${i}`), [])

  dir = mkdtempSync(join(tmpdir(), 'doar-rescue-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  sync = new SyncManager({
    db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit: () => {},
    rescue: async ({ accountId: id, folderPath, messageIds }) => {
      calls.push({ folderPath, count: messageIds.length })
      if (failRescue) throw Object.assign(new Error('plný disk'), { code: 'DISK_FULL' })
      const r = await rescueMessages({ db, store, blobs, dir: join(dir, 'zachranene') }, id, folderPath, messageIds)
      if (r) rescued.push(r)
    }
  })
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: USER, displayName: 'Záchrana', username: USER,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: true, providerKey: null
    },
    password: srv.password,
    rememberPassword: true
  })
  accountId = acc.id
  sync.start(accountId)
  await until(() => sync.get(accountId)!.status.lastSync !== null && store.countNeedingBodies(accountId) === 0, 30_000)
})

afterAll(async () => {
  await sync?.stopAll()
  await other?.logout().catch(() => {})
})

describe('záchrana lokálnych kópií pred hromadným zmazaním zo servera', () => {
  it('schránka zmazaná a založená nanovo (iné UIDVALIDITY) → kópie sa uložia do súboru, až potom sa priečinok vyprázdni', async () => {
    expect(localCount('Projekt')).toBe(6)
    await other.mailboxDelete('Projekt')
    await other.mailboxCreate('Projekt')
    await syncNow()
    expect(calls).toEqual([{ folderPath: 'Projekt', count: 6 }])
    expect(localCount('Projekt')).toBe(0)
    const r = rescued[0]!
    expect(r).toMatchObject({ email: USER, folderPath: 'Projekt', written: 6, missing: 0 })
    expect(basename(r.path)).toMatch(/^Zachránené – zachrana@doar\.test – Projekt – .*\.mbox$/)
    expect(existsSync(`${r.path}.part`)).toBe(false)
    // Formát zálohy Doar: dá sa obnoviť do konta (priečinok, príznaky, kontrolný súčet).
    const entries = entriesOf(r.path)
    expect(entries).toHaveLength(6)
    expect(entries.every((e) => e.hashOk && e.block?.folderSegments.join('/') === 'Projekt')).toBe(true)
    expect(entries.some((e) => e.block!.flags.has('\\Flagged'))).toBe(true)
  })

  it('priečinok zmazaný na serveri → kópie sa uložia, potom sa priečinok zmaže aj lokálne', async () => {
    calls.length = 0
    await other.mailboxDelete('Staré')
    await syncNow()
    expect(calls).toEqual([{ folderPath: 'Staré', count: 5 }])
    expect(folder('Staré')).toBeUndefined()
    expect(entriesOf(rescued.at(-1)!.path)).toHaveLength(5)
  })

  it('jedna správa zmazaná inde → bez záchrany; celá doručená pošta naraz → záchrana', async () => {
    calls.length = 0
    let lock = await other.getMailboxLock('INBOX')
    try {
      await other.messageDelete('1')
    } finally {
      lock.release()
    }
    await syncNow()
    expect(calls).toEqual([])
    expect(localCount('INBOX')).toBe(24)

    lock = await other.getMailboxLock('INBOX')
    try {
      await other.messageDelete('1:*')
    } finally {
      lock.release()
    }
    await syncNow()
    expect(calls).toEqual([{ folderPath: 'INBOX', count: 24 }])
    expect(localCount('INBOX')).toBe(0)
    expect(rescued.at(-1)!.written).toBe(24)
  })

  it('záchrana zlyhá (napr. plný disk) → nič sa nezmaže a stav ukáže RESCUE_FAILED; potom prebehne normálne', async () => {
    await other.mailboxCreate('Zmluvy')
    for (let i = 1; i <= 5; i++) await other.append('Zmluvy', msg(`Zmluva ${i}`), [])
    await syncNow()
    await until(() => store.countNeedingBodies(accountId) === 0)
    expect(localCount('Zmluvy')).toBe(5)

    calls.length = 0
    failRescue = true
    await other.mailboxDelete('Zmluvy')
    await syncNow()
    expect(calls).toEqual([{ folderPath: 'Zmluvy', count: 5 }])
    expect(localCount('Zmluvy')).toBe(5) // správy ostali
    expect(sync.get(accountId)!.status).toMatchObject({ state: 'error', code: 'RESCUE_FAILED' })

    failRescue = false
    await syncNow()
    expect(folder('Zmluvy')).toBeUndefined()
    expect(sync.get(accountId)!.status.state).toBe('idle')
    expect(rescued.at(-1)!.folderPath).toBe('Zmluvy')
  })
})

describe('záloha len z kópií v počítači (bez servera)', () => {
  it('server nedostupný → záloha z lokálnych kópií; správa bez stiahnutého obsahu = neúplná záloha s „-NEUPLNA“', async () => {
    await other.mailboxCreate('Archív')
    for (let i = 1; i <= 3; i++) await other.append('Archív', msg(`Archív ${i}`), ['\\Seen'])
    await syncNow()
    await until(() => store.countNeedingBodies(accountId) === 0)
    await sync.stopAll()

    const out = mkdtempSync(join(tmpdir(), 'doar-rescue-out-'))
    const exports = new ExportManager({
      db, store, blobs, emit: () => {},
      // Server „nedostupný“ – záloha sa nesmie ani pokúsiť pripojiť.
      newClient: () => Promise.reject(Object.assign(new Error('Wrong username or password'), { authenticationFailed: true }))
    })
    const run = async (name: string): Promise<ExportSummary> => {
      const p = join(out, name)
      exports.allow(p)
      return (await exports.wait(exports.start(accountId, p, 'local').jobId))!
    }

    const full = await run('Doar-lokalne.mbox')
    expect(full).toMatchObject({ result: 'complete', local: true, downloaded: 0 })
    expect(full.totals.exported).toBe(3)
    expect(entriesOf(full.path!).every((e) => e.block && e.hashOk)).toBe(true)

    // Jednej správe chýba obsah (nikdy sa nestiahol) → v zálohe chýba, súbor je jasne označený ako neúplný.
    const id = store.folderMessageIds(folder('Archív')!.id)[0]!
    db.prepare('UPDATE messages SET blob_sha256 = NULL WHERE id = ?').run(id)
    const part = await run('Doar-lokalne-2.mbox')
    expect(part).toMatchObject({ result: 'incomplete', local: true })
    expect(part.totals).toEqual({ expected: 3, exported: 2, unavailable: 1, failed: 0 })
    expect(part.path).toBe(join(out, 'Doar-lokalne-2-NEUPLNA.mbox'))
    expect(existsSync(join(out, 'Doar-lokalne-2.mbox'))).toBe(false)
    expect(existsSync(`${part.path}.part`)).toBe(false)
  })
})
