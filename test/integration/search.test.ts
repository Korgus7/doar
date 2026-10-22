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

const srv = inject('testserver')
const USER = 'rado@doar.test'

let db: Db
let store: MailStore
let sync: SyncManager
let h: Handlers
let accountId: number

const msg = (subject: string, body: string, from = 'Ján Novák <jan@firma.sk>', date = new Date()) =>
  Buffer.from(
    `From: ${from}\r\nTo: ${USER}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nDate: ${date.toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`
  )

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

const subjects = async (query: string, scope: { folderId?: number | null; accountId?: number | null } = {}) =>
  (await h['messages.search']({ query, ...scope, offset: 0, limit: 50 })).items.map((m) => m.subject)

beforeAll(async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user: USER, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })
  await c.connect()
  await c.mailboxCreate('Projekty')
  const day = 86_400_000
  await c.append('INBOX', msg('Faktúra za september', 'Suma 120 €. Splatnosť 14 dní.', undefined, new Date(Date.now() - 3 * day)), [], new Date(Date.now() - 3 * day))
  await c.append('INBOX', msg('Faktúra za október', 'Suma 99 €.', undefined, new Date(Date.now() - day)), [], new Date(Date.now() - day))
  await c.append('INBOX', msg('Žiadosť o stretnutie', 'Môžeme sa stretnúť vo štvrtok?', 'Eva <eva@mail.sk>'), [])
  await c.append('Projekty', msg('Projekt Žltá ponorka', 'Rozpočet a faktúra budú v prílohe.', 'Šéf <sef@firma.sk>'), [])
  await c.logout()

  const dir = mkdtempSync(join(tmpdir(), 'doar-search-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: USER, displayName: 'Rado', username: USER,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: false, providerKey: null
    },
    password: srv.password,
    rememberPassword: true
  })
  accountId = acc.id
  const emit = () => {}
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit, undoDelayMs: 300 })
  h = createHandlers({
    files: new FileGrants(), db, blobs, store, sync, secrets,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }), sessionSecrets: new MemorySecrets(), emit,
    imports: new ImportManager({ db, store, blobs, emit, files: new FileGrants(), newClient: (id) => sync.newImapClient(id) }),
    archives: new ArchiveManager({ db, files: new FileGrants(), emit }),
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  sync.startAll()
  await until(() => sync.get(accountId)!.status.lastSync !== null && store.countNeedingBodies(accountId) === 0)
})

afterAll(async () => {
  await sync?.stopAll()
})

const folderId = (path: string) => store.listFolders(accountId).find((f) => f.path === path)!.id

describe('vyhľadávanie v pošte', () => {
  it('v predmete aj v texte, bez diakritiky, od najnovších, cez všetky priečinky', async () => {
    expect(await subjects('faktura')).toEqual(['Projekt Žltá ponorka', 'Faktúra za október', 'Faktúra za september'])
    expect(await subjects('splatnost')).toEqual(['Faktúra za september'])
    expect(await subjects('ziadost stretnut')).toEqual(['Žiadosť o stretnutie'])
    expect(await subjects('od:eva')).toEqual(['Žiadosť o stretnutie'])
  })

  it('rozsah: len priečinok alebo len konto', async () => {
    expect(await subjects('faktura', { folderId: folderId('Projekty') })).toEqual(['Projekt Žltá ponorka'])
    expect(await subjects('faktura', { folderId: folderId('INBOX') })).toHaveLength(2)
    expect(await subjects('faktura', { accountId })).toHaveLength(3)
    expect(await subjects('faktura', { accountId: 99999 })).toEqual([])
  })

  it('výsledok má celkový počet, ID pre „vybrať všetko“ a informáciu o nestiahnutých správach', async () => {
    const r = await h['messages.search']({ query: 'faktura', offset: 1, limit: 1 })
    expect(r.total).toBe(3)
    expect(r.items.map((m) => m.subject)).toEqual(['Faktúra za október'])
    expect(r.notDownloaded).toBe(0)
    expect(await h['messages.searchIds']({ query: 'faktura' })).toHaveLength(3)
    // Správa bez stiahnutého textu: nájde sa podľa predmetu, nie podľa textu – a Doar to povie.
    const id = r.items[0]!.id
    db.prepare('UPDATE messages SET blob_sha256 = NULL WHERE id = ?').run(id)
    expect((await h['messages.search']({ query: 'faktura', offset: 0, limit: 10 })).notDownloaded).toBe(1)
  })

  it('presunutá do Koša: vo výsledkoch je hneď v Koši (čaká na server), po presune tiež – raz', async () => {
    const id = (await h['messages.search']({ query: 'september', offset: 0, limit: 5 })).items[0]!.id
    const trashId = store.listFolders(accountId).find((f) => f.specialUse === 'trash')!.id
    sync.moveMessages([id], { special: 'trash' })
    // Počas času na „Vrátiť späť“: jeden výsledok, už v Koši, so značkou „čaká na server“.
    const now = (await h['messages.search']({ query: 'september', offset: 0, limit: 5 })).items
    expect(now.map((m) => [m.id, m.folderId, m.localState])).toEqual([[id, trashId, 'pending']])
    expect(await h['messages.search']({ query: 'september', folderId: trashId, offset: 0, limit: 5 })).toMatchObject({ total: 1 })
    await until(async () => (await h['messages.search']({ query: 'september', offset: 0, limit: 5 })).items[0]?.localState === 'synced')
    const hit = (await h['messages.search']({ query: 'september', offset: 0, limit: 5 })).items
    expect(hit).toHaveLength(1)
    expect(hit[0]!.folderId).toBe(trashId)
  })

  it('prázdny alebo nezmyselný dotaz → nič (bez chyby)', async () => {
    expect(await subjects('')).toEqual([])
    expect(await subjects('"""')).toEqual([])
    expect(await subjects('NOT OR AND')).toEqual([])
  })
})
