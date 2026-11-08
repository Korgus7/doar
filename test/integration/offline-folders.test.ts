import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { passwordKey } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'
import { createHandlers, type Handlers } from '../../src/core/handlers'
import { FileGrants } from '../../src/core/files'
import { ExportManager } from '../../src/core/export/manager'
import { ImportManager } from '../../src/core/import/manager'
import { ArchiveManager } from '../../src/core/archive/archive'

// Priečinky bez pripojenia (zmena hneď v Doare, na server po pripojení) a konto „len v počítači“.

const srv = inject('testserver')
const USER = 'priecinky@doar.test'
const LOCAL = 'lokalne@doar.test'

let dir: string
let db: Db
let store: MailStore
let blobs: BlobStore
let secrets: MemorySecrets
let sync: SyncManager
let h: Handlers
let accountId: number
let localId: number

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
const serverSubjects = (user: string, path: string) =>
  onServer(user, async (c) => {
    const lock = await c.getMailboxLock(path)
    try {
      if (!c.mailbox || !c.mailbox.exists) return []
      const out: string[] = []
      for await (const m of c.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '')
      return out.sort()
    } finally {
      lock.release()
    }
  })

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

const mail = (to: string, s: string) => Buffer.from(`From: jan@firma.sk\r\nTo: ${to}\r\nSubject: ${s}\r\nMessage-ID: <${s.replace(/\W/g, '')}@firma.sk>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText: ${s}\r\n`)

function startApp(): void {
  const emit = () => {}
  const session = new MemorySecrets()
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: session, emit, undoDelayMs: 300, draftDelayMs: 300 })
  h = createHandlers({
    files: new FileGrants(), db, blobs, store, sync, secrets, sessionSecrets: session, emit,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }),
    imports: new ImportManager({ db, store, blobs, emit, files: new FileGrants(), newClient: (id) => sync.newImapClient(id) }),
    archives: new ArchiveManager({ db, files: new FileGrants(), emit }),
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  sync.startAll()
}

/** Server „nedostupný“: konto ukazuje na zatvorený port (spojenie odmietnuté ako pri výpadku siete). */
function setOnline(id: number, online: boolean): void {
  db.prepare('UPDATE accounts SET imap_port = ?, smtp_port = ? WHERE id = ?').run(online ? srv.ports.imaps : 1, online ? srv.ports.smtps : 1, id)
}

const folders = (id: number) => store.listFolders(id)
const byName = (id: number, name: string) => folders(id).find((f) => f.name === name)
const special = (id: number, use: string) => folders(id).find((f) => f.specialUse === use)!
const subjects = (folderId: number) => store.listMessages(folderId, 0, 100).items.map((m) => m.subject).sort()
const status = (id: number) => sync.statuses().find((s) => s.accountId === id)!

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
  await onServer(USER, async (c) => {
    for (const f of ['Projekt', 'Starý', 'Obsadené']) await c.mailboxCreate(f)
    for (const s of ['Projekt 1', 'Projekt 2']) await c.append('Projekt', mail(USER, s), [])
    await c.append('Starý', mail(USER, 'Stará správa'), [])
    await c.append('INBOX', mail(USER, 'Do nového'), [])
  })
  await onServer(LOCAL, async (c) => {
    for (const f of ['Odložené', 'Vybavené']) await c.mailboxCreate(f)
    for (const s of ['Zmluva', 'Faktúra', 'Fotky']) await c.append('Odložené', mail(LOCAL, s), [])
    await c.append('INBOX', mail(LOCAL, 'Pozdrav'), [])
  })
  dir = mkdtempSync(join(tmpdir(), 'doar-offline-folders-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  blobs = new BlobStore(join(dir, 'blobs'))
  secrets = new MemorySecrets(true)
  accountId = await add(USER)
  localId = await add(LOCAL)
  startApp()
  await until(() => [accountId, localId].every((id) => status(id).lastSync !== null && store.countNeedingBodies(id) === 0))
})

afterAll(async () => {
  await sync?.stopAll()
})

describe('priečinky bez pripojenia', () => {
  it('premenovanie, presun, nový priečinok a odstránenie sa urobia hneď v Doare a čakajú vo fronte', async () => {
    await sync.stopAll()
    setOnline(accountId, false)
    startApp()
    await until(() => status(accountId).state === 'offline')

    const projekt = byName(accountId, 'Projekt')!
    const ids = store.listMessages(projekt.id, 0, 10).items.map((m) => m.id).sort()
    await h['folders.rename']({ folderId: projekt.id, name: 'Projekt 2026', parentId: null })
    expect(byName(accountId, 'Projekt')).toBeUndefined()
    const renamed = byName(accountId, 'Projekt 2026')!
    expect(renamed.id).toBe(projekt.id)
    expect(store.listMessages(renamed.id, 0, 10).items.map((m) => m.id).sort()).toEqual(ids)

    const { folderId: novy } = await h['folders.create']({ accountId, parentId: renamed.id, name: 'Nový' })
    expect(folders(accountId).find((f) => f.id === novy)?.parentPath).toBe(renamed.path)
    const inbox = special(accountId, 'inbox')
    const msg = store.listMessages(inbox.id, 0, 10).items.find((m) => m.subject === 'Do nového')!
    await h['messages.move']({ ids: [msg.id], folderId: novy })
    expect(subjects(novy)).toEqual(['Do nového'])

    const stary = byName(accountId, 'Starý')!
    const r = await h['folders.delete']({ folderId: stary.id })
    expect(r.moved).toBe(1)
    expect(byName(accountId, 'Starý')).toBeUndefined()
    expect(subjects(special(accountId, 'trash').id)).toContain('Stará správa')

    // Server zatiaľ nič nevie.
    expect(await serverFolders(USER)).toContain('Projekt')
    await until(() => status(accountId).pendingChanges >= 4)
  })

  it('po pripojení sa zmeny vykonajú na serveri v poradí; správy si ponechajú ID', async () => {
    const renamedId = byName(accountId, 'Projekt 2026')!.id
    const ids = store.listMessages(renamedId, 0, 10).items.map((m) => m.id).sort()
    setOnline(accountId, true)
    await sync.stopAll()
    startApp()
    sync.reconnectAll()
    await until(async () => {
      const list = await serverFolders(USER)
      return list.includes('Projekt 2026') && list.includes('Projekt 2026/Nový') && !list.includes('Projekt') && !list.includes('Starý')
    })
    await until(async () => (await serverSubjects(USER, 'Projekt 2026/Nový')).includes('Do nového'))
    expect(await serverSubjects(USER, 'Projekt 2026')).toEqual(['Projekt 1', 'Projekt 2'])
    await until(async () => (await serverSubjects(USER, 'Trash')).includes('Stará správa'))
    await until(() => status(accountId).pendingChanges === 0 && status(accountId).state === 'idle')
    await until(() => subjects(special(accountId, 'trash').id).includes('Stará správa'))
    expect(byName(accountId, 'Projekt 2026')!.id).toBe(renamedId)
    expect(store.listMessages(renamedId, 0, 10).items.map((m) => m.id).sort()).toEqual(ids)
    expect(subjects(byName(accountId, 'Nový')!.id)).toEqual(['Do nového'])
  })

  it('server zmenu odmietne (názov medzitým obsadený) → priečinok sa vráti, ako je na serveri', async () => {
    await sync.stopAll()
    setOnline(accountId, false)
    startApp()
    await until(() => status(accountId).state === 'offline')
    const obsadene = byName(accountId, 'Obsadené')!
    await h['folders.rename']({ folderId: obsadene.id, name: 'Cieľ', parentId: null })
    expect(byName(accountId, 'Cieľ')?.id).toBe(obsadene.id)
    // Medzitým niekto iný (webmail) založil priečinok s tým istým názvom.
    await onServer(USER, (c) => c.mailboxCreate('Cieľ'))

    setOnline(accountId, true)
    await sync.stopAll()
    startApp()
    sync.reconnectAll()
    await until(() => !!byName(accountId, 'Obsadené') && !!byName(accountId, 'Cieľ') && status(accountId).state === 'idle')
    expect(byName(accountId, 'Obsadené')!.id).toBe(obsadene.id)
    expect(await serverFolders(USER)).toEqual(expect.arrayContaining(['Obsadené', 'Cieľ']))
    expect(status(accountId).pendingChanges).toBe(0)
  })
})

describe('konto len v počítači', () => {
  it('po odpojení sa Doar na server nepripája; pošta ostane, heslo sa zmaže', async () => {
    await h['accounts.makeLocal']({ id: localId })
    expect((await h['accounts.list']()).find((a) => a.id === localId)!.localOnly).toBe(true)
    expect(await secrets.get(passwordKey(localId))).toBeNull()
    expect(status(localId)).toMatchObject({ state: 'idle', pendingBodies: 0, pendingChanges: 0 })
    expect(subjects(byName(localId, 'Odložené')!.id)).toEqual(['Faktúra', 'Fotky', 'Zmluva'])
    // Server sa nepoužíva ani pre zálohu zo servera či obnovu.
    await expect(sync.newImapClient(localId)).rejects.toMatchObject({ code: 'LOCAL_ONLY' })
    await expect(h['compose.send']({ accountId: localId, to: 'jan@firma.sk', cc: '', bcc: '', subject: 'x', text: 'x', replyToMessage: null })).rejects.toMatchObject({ code: 'LOCAL_ONLY_SEND' })
  })

  it('presuny, Vrátiť späť, príznaky, mazanie a priečinky fungujú len lokálne – server sa nemení', async () => {
    const odlozene = byName(localId, 'Odložené')!
    const vybavene = byName(localId, 'Vybavené')!
    const id = (s: string, f = odlozene.id) => store.listMessages(f, 0, 10).items.find((m) => m.subject === s)!.id

    // Presun a Vrátiť späť.
    const undo = await h['messages.move']({ ids: [id('Fotky')], folderId: vybavene.id })
    expect(subjects(vybavene.id)).toEqual(['Fotky'])
    expect((await h['messages.undo']({ undo: undo.undo })).undone).toBe(true)
    expect(subjects(odlozene.id)).toEqual(['Faktúra', 'Fotky', 'Zmluva'])

    // Presun sa vykoná po čase na „Vrátiť späť“ – ten istý záznam, originál ostáva.
    const zmluva = id('Zmluva')
    await h['messages.move']({ ids: [zmluva], folderId: vybavene.id })
    await until(() => store.message(zmluva)!.folder_id === vybavene.id && store.message(zmluva)!.moving_to === null)
    expect((await h['messages.get']({ id: zmluva })).text).toContain('Text: Zmluva')

    await h['messages.setFlags']({ ids: [zmluva], flagged: true })
    expect(store.message(zmluva)!.flagged).toBe(1)

    // Do Koša (Kôš existuje zo servera) a natrvalo.
    await h['messages.move']({ ids: [id('Faktúra')], special: 'trash' })
    await until(() => subjects(special(localId, 'trash').id).includes('Faktúra'))
    const faktura = store.listMessages(special(localId, 'trash').id, 0, 10).items.find((m) => m.subject === 'Faktúra')!.id
    await h['messages.deleteForever']({ ids: [faktura] })
    expect(store.message(faktura)).toBeNull()

    // Priečinky: nový, presun pod iný, premenovanie, odstránenie (správy do Koša).
    const { folderId: archiv } = await h['folders.create']({ accountId: localId, parentId: null, name: 'Archív 2025' })
    await h['folders.rename']({ folderId: vybavene.id, name: 'Vybavené', parentId: archiv })
    expect(folders(localId).find((f) => f.id === vybavene.id)!.parentPath).toBe('Archív 2025')
    await h['folders.rename']({ folderId: archiv, name: 'Staré', parentId: null })
    expect(folders(localId).find((f) => f.id === vybavene.id)!.path).toMatch(/^Staré.Vybavené$/)
    await expect(h['folders.rename']({ folderId: special(localId, 'inbox').id, name: 'X', parentId: null })).rejects.toMatchObject({ code: 'FOLDER_PROTECTED' })
    await expect(h['folders.rename']({ folderId: archiv, name: 'X', parentId: vybavene.id })).rejects.toMatchObject({ code: 'FOLDER_INTO_ITSELF' })
    const del = await h['folders.delete']({ folderId: archiv })
    expect(del.moved).toBe(1)
    expect(byName(localId, 'Staré')).toBeUndefined()
    expect(byName(localId, 'Vybavené')).toBeUndefined()
    expect(subjects(special(localId, 'trash').id)).toContain('Zmluva')
    expect((await h['messages.get']({ id: zmluva })).text).toContain('Text: Zmluva')

    // Na serveri sa nič nezmenilo.
    expect(await serverFolders(LOCAL)).toEqual(expect.arrayContaining(['Odložené', 'Vybavené']))
    expect(await serverFolders(LOCAL)).not.toContain('Archív 2025')
    expect(await serverSubjects(LOCAL, 'Odložené')).toEqual(['Faktúra', 'Fotky', 'Zmluva'])
    expect(status(localId).pendingChanges).toBe(0)
  })

  it('po reštarte ostáva len v počítači; schránku na serveri možno pridať znova ako nové konto', async () => {
    await sync.stopAll()
    startApp()
    expect(status(localId).state).toBe('idle')
    expect(subjects(byName(localId, 'Odložené')!.id)).toEqual(['Fotky'])
    const again = await add(LOCAL)
    expect(again).not.toBe(localId)
    sync.start(again)
    await until(() => status(again).lastSync !== null)
    expect(subjects(folders(again).find((f) => f.name === 'Odložené')!.id)).toEqual(['Faktúra', 'Fotky', 'Zmluva'])
    expect(subjects(byName(localId, 'Odložené')!.id)).toEqual(['Fotky'])
  })
})
