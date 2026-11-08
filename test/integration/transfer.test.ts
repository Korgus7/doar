import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
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

// Presun a kópia medzi kontami: správy aj priečinky, IMAP → IMAP, konto len v počítači → IMAP a naopak.

const srv = inject('testserver')
const SRC = 'zdroj@doar.test'
const DST = 'ciel@doar.test'
const ARCH = 'archiv@doar.test'

let dir: string
let db: Db
let store: MailStore
let sync: SyncManager
let h: Handlers
let src: number
let dst: number
let arch: number

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

async function onServer<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = imap(user)
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.logout()
  }
}

const serverFolders = (user: string) => onServer(user, async (c) => (await c.list()).map((f) => f.path).sort())
const serverMail = (user: string, path: string) =>
  onServer(user, async (c) => {
    const lock = await c.getMailboxLock(path)
    try {
      if (!c.mailbox || !c.mailbox.exists) return []
      const out: { subject: string; flags: string[] }[] = []
      for await (const m of c.fetch('1:*', { envelope: true, flags: true })) out.push({ subject: m.envelope?.subject ?? '', flags: [...(m.flags ?? [])] })
      return out.sort((a, b) => a.subject.localeCompare(b.subject))
    } finally {
      lock.release()
    }
  })
const serverSubjects = async (user: string, path: string) => (await serverMail(user, path)).map((m) => m.subject)

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

const mail = (to: string, s: string) => Buffer.from(`From: jan@firma.sk\r\nTo: ${to}\r\nSubject: ${s}\r\nMessage-ID: <${s.replace(/\W/g, '')}@firma.sk>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText: ${s}\r\n`)

const folders = (id: number) => store.listFolders(id)
const byName = (id: number, name: string) => folders(id).find((f) => f.name === name)
const special = (id: number, use: string) => folders(id).find((f) => f.specialUse === use)!
const items = (folderId: number) => store.listMessages(folderId, 0, 100).items
const subjects = (folderId: number) => items(folderId).map((m) => m.subject).sort()
const status = (id: number) => sync.statuses().find((s) => s.accountId === id)!

let secrets: MemorySecrets

async function add(user: string): Promise<number> {
  return (
    await addAccount(db, secrets, secrets, {
      settings: {
        email: user, displayName: user, username: user,
        imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
        smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
        saveSentCopy: true, providerKey: null
      },
      password: srv.password,
      rememberPassword: true
    })
  ).id
}

beforeAll(async () => {
  await onServer(SRC, async (c) => {
    for (const s of ['Faktúra', 'Zmluva', 'Fotky']) await c.append('INBOX', mail(SRC, s), s === 'Zmluva' ? ['\\Seen', '\\Flagged'] : [])
    await c.mailboxCreate('Projekt')
    await c.mailboxCreate('Projekt/2026')
    await c.append('Projekt', mail(SRC, 'Projekt A'), ['\\Seen'])
    await c.append('Projekt/2026', mail(SRC, 'Projekt B'), [])
  })
  await onServer(DST, (c) => c.append('INBOX', mail(DST, 'Vlastná'), []))
  await onServer(ARCH, async (c) => {
    await c.mailboxCreate('Odložené')
    for (const s of ['Staré 1', 'Staré 2', 'Staré 3']) await c.append('Odložené', mail(ARCH, s), [])
  })
  dir = mkdtempSync(join(tmpdir(), 'doar-transfer-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  secrets = new MemorySecrets(true)
  const session = new MemorySecrets()
  const emit = () => {}
  src = await add(SRC)
  dst = await add(DST)
  arch = await add(ARCH)
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: session, emit, undoDelayMs: 300 })
  h = createHandlers({
    files: new FileGrants(), db, blobs, store, sync, secrets, sessionSecrets: session, emit,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }),
    imports: new ImportManager({ db, store, blobs, emit, files: new FileGrants(), newClient: (id) => sync.newImapClient(id) }),
    archives: new ArchiveManager({ db, files: new FileGrants(), emit }),
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  sync.startAll()
  await until(() => [src, dst, arch].every((id) => status(id).lastSync !== null && store.countNeedingBodies(id) === 0))
})

afterAll(async () => {
  await sync?.stopAll()
})

describe('presun medzi kontami', () => {
  it('správy: nahrajú sa do cieľa aj s príznakmi, v pôvodnom konte idú do Koša', async () => {
    const inbox = special(src, 'inbox')
    const ids = items(inbox.id).filter((m) => m.subject === 'Faktúra' || m.subject === 'Zmluva').map((m) => m.id)
    const r = await h['transfer.messages']({ ids, folderId: special(dst, 'inbox').id, copy: false })
    expect(r).toMatchObject({ total: 2, transferred: 2, duplicates: 0, unavailable: 0, failed: 0, copy: false })
    const box = await serverMail(DST, 'INBOX')
    expect(box.map((m) => m.subject)).toEqual(['Faktúra', 'Vlastná', 'Zmluva'])
    expect(box.find((m) => m.subject === 'Zmluva')!.flags).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']))
    await until(async () => (await serverSubjects(SRC, 'Trash')).length === 2)
    expect(await serverSubjects(SRC, 'INBOX')).toEqual(['Fotky'])
    await until(() => subjects(special(dst, 'inbox').id).join() === 'Faktúra,Vlastná,Zmluva')
  })

  it('kópia toho istého znova: v cieli už sú – nenahrajú sa druhýkrát; pôvodné ostanú', async () => {
    await until(() => subjects(special(src, 'trash').id).length === 2)
    const ids = items(special(src, 'trash').id).map((m) => m.id)
    const r = await h['transfer.messages']({ ids, folderId: special(dst, 'inbox').id, copy: true })
    expect(r).toMatchObject({ total: 2, transferred: 0, duplicates: 2 })
    expect(await serverSubjects(DST, 'INBOX')).toEqual(['Faktúra', 'Vlastná', 'Zmluva'])
    expect(await serverSubjects(SRC, 'Trash')).toEqual(['Faktúra', 'Zmluva'])
  })

  it('priečinok s podpriečinkom: vznikne v cieli so správami, pôvodný sa odstráni (správy do Koša)', async () => {
    const r = await h['transfer.folder']({ folderId: byName(src, 'Projekt')!.id, accountId: dst, parentId: null, copy: false })
    expect(r).toMatchObject({ total: 2, transferred: 2, failed: 0 })
    expect(r.kept).toBeFalsy()
    expect(await serverFolders(DST)).toEqual(expect.arrayContaining(['Projekt', 'Projekt/2026']))
    expect(await serverSubjects(DST, 'Projekt')).toEqual(['Projekt A'])
    expect(await serverSubjects(DST, 'Projekt/2026')).toEqual(['Projekt B'])
    await until(async () => !(await serverFolders(SRC)).includes('Projekt'))
    expect(await serverSubjects(SRC, 'Trash')).toEqual(expect.arrayContaining(['Projekt A', 'Projekt B']))
    await until(() => !!byName(dst, '2026') && subjects(byName(dst, '2026')!.id).join() === 'Projekt B')
    expect(byName(src, 'Projekt')).toBeUndefined()
  })

  it('cieľ nedostupný: nič sa nepresunie, chyba povie prečo', async () => {
    db.prepare('UPDATE accounts SET imap_port = 1 WHERE id = ?').run(dst)
    const fotky = items(special(src, 'inbox').id).find((m) => m.subject === 'Fotky')!.id
    await expect(h['transfer.messages']({ ids: [fotky], folderId: special(dst, 'inbox').id, copy: false })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    db.prepare('UPDATE accounts SET imap_port = ? WHERE id = ?').run(srv.ports.imaps, dst)
    expect(subjects(special(src, 'inbox').id)).toEqual(['Fotky'])
    expect(await serverSubjects(SRC, 'INBOX')).toEqual(['Fotky'])
  })
})

describe('konto len v počítači', () => {
  it('z konta len v počítači do konta na serveri: správy bez obsahu v počítači sa nedajú, priečinok ostane', async () => {
    await h['accounts.makeLocal']({ id: arch })
    const odlozene = byName(arch, 'Odložené')!
    // Jedna správa sa do počítača nestihla stiahnuť.
    const missing = items(odlozene.id).find((m) => m.subject === 'Staré 3')!.id
    db.prepare('UPDATE messages SET blob_sha256 = NULL WHERE id = ?').run(missing)
    const r = await h['transfer.folder']({ folderId: odlozene.id, accountId: dst, parentId: null, copy: false })
    expect(r).toMatchObject({ total: 3, transferred: 2, unavailable: 1, kept: true })
    expect(await serverSubjects(DST, 'Odložené')).toEqual(['Staré 1', 'Staré 2'])
    // Presunuté sú v Koši konta len v počítači, nepresunutá ostala na mieste.
    await until(() => subjects(special(arch, 'trash').id).join() === 'Staré 1,Staré 2')
    expect(subjects(byName(arch, 'Odložené')!.id)).toEqual(['Staré 3'])
    // Server zrušeného konta sa nemenil.
    expect(await serverSubjects(ARCH, 'Odložené')).toEqual(['Staré 1', 'Staré 2', 'Staré 3'])
  })

  it('do konta len v počítači: lokálna kópia s obsahom a hľadaním, server sa nepoužije', async () => {
    const fotky = items(special(src, 'inbox').id).find((m) => m.subject === 'Fotky')!.id
    const r = await h['transfer.messages']({ ids: [fotky], folderId: byName(arch, 'Odložené')!.id, copy: true })
    expect(r).toMatchObject({ total: 1, transferred: 1 })
    const copyId = items(byName(arch, 'Odložené')!.id).find((m) => m.subject === 'Fotky')!.id
    expect(copyId).not.toBe(fotky)
    expect((await h['messages.get']({ id: copyId })).text).toContain('Text: Fotky')
    const found = await h['messages.search']({ query: 'Fotky', offset: 0, limit: 10 })
    expect(found.items.map((m) => m.accountId).sort()).toEqual([src, arch].sort())
    expect(await serverSubjects(ARCH, 'Odložené')).toEqual(['Staré 1', 'Staré 2', 'Staré 3'])
    expect(subjects(special(src, 'inbox').id)).toEqual(['Fotky'])
  })
})
