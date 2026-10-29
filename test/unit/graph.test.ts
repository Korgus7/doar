import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { SyncManager } from '../../src/core/sync/manager'
import { createHandlers, type Handlers } from '../../src/core/handlers'
import { FileGrants } from '../../src/core/files'
import { ExportManager } from '../../src/core/export/manager'
import { ImportManager } from '../../src/core/import/manager'
import { ArchiveManager } from '../../src/core/archive/archive'
import type { OAuthService } from '../../src/core/oauth/oauth'
import type { DraftSaveInput } from '../../src/shared/ipc'
import { FakeGraph } from '../fixtures/graph-server'
import { readMbox, parseEntry } from '../../src/core/import/mbox-reader'

/** Kontá Outlook.com / Microsoft 365 cez Microsoft Graph – proti testovaciemu serveru Graph. */

let graph: FakeGraph
let db: Db
let store: MailStore
let sync: SyncManager
let h: Handlers
let exportManager: ExportManager
let accountId: number
const newMail: number[][] = []

const mime = (subject: string, opts: { from?: string; id?: string; to?: string; bcc?: string } = {}): string =>
  `From: ${opts.from ?? 'Ján Novák <jan@firma.sk>'}\r\nTo: ${opts.to ?? 'test@outlook.com'}\r\n${opts.bcc ? `Bcc: ${opts.bcc}\r\n` : ''}Subject: ${subject}\r\nMessage-ID: ${opts.id ?? `<${Math.random().toString(36).slice(2)}@firma.sk>`}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${subject} – telo\r\n`

async function until(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('časový limit')
}

const folder = (use: string) => store.listFolders(accountId).find((f) => f.specialUse === use)!
const byName = (name: string) => store.listFolders(accountId).find((f) => f.name === name)
const items = (folderId: number) => store.listMessages(folderId, 0, 200).items
const gs = () => sync.get(accountId)!

beforeAll(async () => {
  graph = new FakeGraph()
  await graph.start()
  const dir = mkdtempSync(join(tmpdir(), 'doar-graph-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  accountId = (db
    .prepare(
      `INSERT INTO accounts(email, display_name, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, username, auth_type, provider_key, protocol, password_storage)
       VALUES ('test@outlook.com', 'Test', 'graph.microsoft.com', 443, 'tls', 'graph.microsoft.com', 443, 'tls', 'test@outlook.com', 'oauth2', 'microsoft', 'graph', 'os') RETURNING id`
    )
    .get() as { id: number }).id
  const oauth = { accessToken: async () => graph.token, invalidate: () => {} } as unknown as OAuthService
  const emit = () => {}
  sync = new SyncManager({
    db, store, blobs, secrets: new MemorySecrets(true), sessionSecrets: new MemorySecrets(), emit, oauth, graphBase: graph.base, undoDelayMs: 0, draftDelayMs: 0,
    onNewMail: (n) => newMail.push(n.messageIds)
  })
  h = createHandlers({
    files: new FileGrants(), db, blobs, store, sync, secrets: new MemorySecrets(true),
    exports: (exportManager = new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id), graphClient: (id) => sync.graphClient(id) })), sessionSecrets: new MemorySecrets(), emit,
    imports: new ImportManager({ db, store, blobs, emit, files: new FileGrants(), newClient: (id) => sync.newImapClient(id) }),
    archives: new ArchiveManager({ db, files: new FileGrants(), emit }),
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  graph.pageSize = 2 // stránkovanie delta
  const projekty = graph.addFolder('Projekty', null)
  graph.addFolder('2026', projekty)
  for (const s of ['Prvá', 'Druhá', 'Tretia']) await graph.addMessage('inbox', mime(s), { isRead: s === 'Prvá' })
  sync.startAll()
  await until(() => gs().status.lastSync !== null)
})

afterAll(async () => {
  await sync?.stopAll()
  await graph?.close()
})

describe('Graph: synchronizácia', () => {
  it('priečinky (bez Pošty na odoslanie), vnorené, špeciálne; správy cez stránkovanú deltu; originál cez /$value', async () => {
    const list = store.listFolders(accountId)
    expect(list.map((f) => [f.name, f.specialUse, f.depth])).toEqual([
      ['Inbox', 'inbox', 0],
      ['Drafts', 'drafts', 0],
      ['Sent Items', 'sent', 0],
      ['Archive', 'archive', 0],
      ['Junk Email', 'junk', 0],
      ['Deleted Items', 'trash', 0],
      ['Projekty', null, 0],
      ['2026', null, 1]
    ])
    const inbox = items(folder('inbox').id)
    expect(inbox.map((m) => [m.subject, m.seen]).sort()).toEqual([['Druhá', false], ['Prvá', true], ['Tretia', false]])
    expect(graph.requests.some((r) => r.includes('skip=2'))).toBe(true)
    // Originály sa stiahnu na pozadí.
    await until(() => store.countNeedingBodies(accountId) === 0)
    const view = await h['messages.get']({ id: inbox[0]!.id })
    expect(view.text).toContain('– telo')
    expect(newMail).toHaveLength(0) // prvé načítanie sa neoznamuje
  })

  it('zmeny zo servera: nová správa (oznámi sa), prečítaná inde, zmazaná inde; neplatný delta odkaz', async () => {
    const [first] = graph.inFolder('inbox')
    graph.update(first!.id, { flagged: true })
    graph.remove(graph.inFolder('inbox').find((m) => m.subject === 'Druhá')!.id)
    await graph.addMessage('inbox', mime('Štvrtá'))
    await h['sync.now']({ accountId })
    const inbox = items(folder('inbox').id)
    expect(inbox.map((m) => m.subject).sort()).toEqual(['Prvá', 'Tretia', 'Štvrtá'])
    expect(inbox.find((m) => m.subject === first!.subject)!.flagged).toBe(true)
    expect(newMail.flat().map((id) => store.message(id)!.subject)).toEqual(['Štvrtá'])

    graph.dropHistory()
    graph.remove(graph.inFolder('inbox').find((m) => m.subject === 'Tretia')!.id)
    await h['sync.now']({ accountId })
    expect(items(folder('inbox').id).map((m) => m.subject).sort()).toEqual(['Prvá', 'Štvrtá'])
  })

  it('lokálne zmeny → server: prečítané, hviezdička, presun (ID ostáva), natrvalo vymazať', async () => {
    const inbox = folder('inbox')
    const m = items(inbox.id).find((x) => x.subject === 'Štvrtá')!
    await h['messages.setFlags']({ ids: [m.id], seen: true, flagged: true })
    await until(() => !!graph.inFolder('inbox').find((x) => x.subject === 'Štvrtá')?.isRead)
    expect(graph.inFolder('inbox').find((x) => x.subject === 'Štvrtá')!.flagged).toBe(true)

    const remote = store.message(m.id)!.remote_id
    h['messages.move']({ ids: [m.id], folderId: byName('Projekty')!.id })
    await until(() => graph.inFolder(graph.folderId('Projekty')).length === 1)
    expect(graph.inFolder(graph.folderId('Projekty'))[0]!.id).toBe(remote)
    await until(() => store.message(m.id)?.folder_id === byName('Projekty')!.id)
    await h['sync.now']({ accountId })
    // Po synchronizácii obidvoch priečinkov len jedna kópia, originál sa nesťahuje znova.
    expect(items(byName('Projekty')!.id).map((x) => x.id)).toEqual([m.id])
    expect(items(inbox.id).map((x) => x.subject)).toEqual(['Prvá'])

    h['messages.deleteForever']({ ids: [m.id] })
    await until(() => graph.inFolder(graph.folderId('Projekty')).length === 0)
    expect(store.message(m.id)).toBeNull()
  })

  it('odoslanie: celé MIME aj so skrytou kópiou, kópia v Odoslaných od servera; nedostupný server → počká', async () => {
    const r = await h['compose.send']({ accountId, to: 'Eva <eva@firma.sk>', cc: '', bcc: 'tajna@firma.sk', subject: 'Cez Graph', text: 'Ahoj z Doaru', attachments: [], replyToMessage: null } as never)
    await until(() => store.outboxRow(r.outboxId)?.state === 'sent')
    expect(graph.sent).toHaveLength(1)
    const raw = graph.sent[0]!.toString()
    expect(raw).toMatch(/Bcc: tajna@firma\.sk/)
    expect(raw).toMatch(/Subject: Cez Graph/)
    expect(store.outboxRow(r.outboxId)!.sent_copy_state).not.toBe('pending')
    await until(() => items(folder('sent').id).some((m) => m.subject === 'Cez Graph'))

    graph.failSend = 503
    const r2 = await h['compose.send']({ accountId, to: 'eva@firma.sk', cc: '', bcc: '', subject: 'Neskôr', text: 'x', attachments: [], replyToMessage: null } as never)
    await until(() => store.outboxRow(r2.outboxId)?.state === 'queued' && store.outboxRow(r2.outboxId)?.error === 'OFFLINE', 20_000)
    graph.failSend = null
    gs().reconnectNow()
    await until(() => store.outboxRow(r2.outboxId)?.state === 'sent', 20_000)
  }, 40_000)

  it('koncept: verzia v Konceptoch, ďalšie uloženie nahradí predošlú; odoslaný koncept zmizne', async () => {
    const base = (over: Partial<DraftSaveInput> = {}): DraftSaveInput => ({ draftId: null, accountId, to: '', cc: '', bcc: '', subject: '', text: '', replyToMessage: null, attachments: [], ...over })
    const d = await h['drafts.save'](base({ to: 'eva@firma.sk', subject: 'Rozpísané', text: 'v1', flush: true }))
    await until(() => graph.inFolder('drafts').length === 1)
    await h['drafts.save'](base({ draftId: d.draftId, to: 'eva@firma.sk', subject: 'Rozpísané v2', text: 'v2', flush: true }))
    await until(() => graph.inFolder('drafts').length === 1 && graph.inFolder('drafts')[0]!.subject === 'Rozpísané v2')
    await until(() => items(folder('drafts').id).length === 1 && items(folder('drafts').id)[0]!.subject === 'Rozpísané v2')
    await h['drafts.discard']({ draftId: d.draftId })
    await until(() => graph.inFolder('drafts').length === 0)
  })

  it('priečinky: nový, premenovať, presunúť, odstrániť (do Odstránenej pošty); špeciálny nie', async () => {
    const { folderId } = await h['folders.create']({ accountId, parentId: byName('Projekty')!.id, name: 'Faktúry' })
    expect(store.listFolders(accountId).find((f) => f.id === folderId)).toMatchObject({ name: 'Faktúry', depth: 1 })
    await expect(h['folders.create']({ accountId, parentId: byName('Projekty')!.id, name: 'faktúry' })).rejects.toMatchObject({ code: 'FOLDER_EXISTS' })
    await h['folders.rename']({ folderId, name: 'Faktúry 2026', parentId: null })
    expect(store.listFolders(accountId).find((f) => f.id === folderId)).toMatchObject({ name: 'Faktúry 2026', depth: 0 })
    expect(graph.folders.get(store.folder(folderId)!.path)).toMatchObject({ displayName: 'Faktúry 2026', parent: null })
    await expect(h['folders.rename']({ folderId: folder('inbox').id, name: 'X', parentId: null })).rejects.toMatchObject({ code: 'FOLDER_PROTECTED' })
    await h['folders.delete']({ folderId })
    expect(store.listFolders(accountId).find((f) => f.name === 'Faktúry 2026')).toMatchObject({ depth: 1 })
    expect(graph.folders.get([...graph.folders.values()].find((f) => f.displayName === 'Faktúry 2026')!.id)!.parent).toBe(graph.folderId('deleteditems'))
  })

  it('záloha mbox cez Graph: priečinky s cestou a úlohou, príznaky, chýbajúce originály sa stiahnu; import cez IMAP zatiaľ nie', async () => {
    // Správa, ktorú Doar ešte nemá (pribudla po poslednej synchronizácii), a prečítaná s hviezdičkou.
    const fresh = await graph.addMessage(graph.folderId('2026'), mime('Iba na serveri'))
    const starred = graph.inFolder('inbox')[0]!
    graph.update(starred.id, { isRead: true, flagged: true })
    const dir = mkdtempSync(join(tmpdir(), 'doar-graph-export-'))
    const path = join(dir, 'outlook.mbox')
    const exports = exportManager
    exports.allow(path)
    const { jobId } = exports.start(accountId, path)
    const summary = (await exports.wait(jobId))!
    expect(summary).toMatchObject({ result: 'complete', errorCode: null, path })
    // Chýbajúce originály (správa „Iba na serveri“, ak ju synchronizácia ešte nestihla) sa stiahnu počas zálohy.
    expect(summary.totals).toMatchObject({ unavailable: 0, failed: 0 })
    const entries: ReturnType<typeof parseEntry>[] = []
    for await (const e of readMbox(path)) entries.push(parseEntry(e.raw))
    const bySubject = (s: string) => entries.find((e) => e!.original.toString().includes(`Subject: ${s}`))!
    expect(bySubject('Iba na serveri')).toMatchObject({ doar: true, hashOk: true, source: 'test@outlook.com', folderSegments: ['Projekty', '2026'], specialUse: null })
    expect(bySubject(starred.subject)).toMatchObject({ folderSegments: ['Inbox'], specialUse: '\\Inbox' })
    expect([...bySubject(starred.subject)!.flags].sort()).toEqual(['\\Flagged', '\\Seen'])
    expect(bySubject('Cez Graph')).toMatchObject({ specialUse: '\\Sent' })
    expect(entries).toHaveLength(graph.messages.size - graph.inFolder('outbox').length)
    expect(fresh).toBeTruthy()
    await expect(sync.newImapClient(accountId)).rejects.toMatchObject({ code: 'GRAPH_UNSUPPORTED' })
  })
})

describe('Graph: prechod doterajších kont Microsoft', () => {
  it('migrácia 019: konto s prihlásením cez Microsoft prejde na Graph, priečinky z IMAP sa zahodia; ostatné kontá nie', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'doar-g19-')), 'doar.db')
    const old = openDb(file)
    old.exec('DELETE FROM schema_migrations WHERE version = 19; DROP INDEX messages_remote; ALTER TABLE messages DROP COLUMN remote_id; ALTER TABLE folders DROP COLUMN delta_link; ALTER TABLE accounts DROP COLUMN protocol')
    old.exec(`INSERT INTO accounts(id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,auth_type,provider_key)
      VALUES (1,'a@outlook.com','outlook.office365.com',993,'tls','smtp.office365.com',587,'starttls','a@outlook.com','oauth2','microsoft'),
             (2,'b@gmail.com','imap.gmail.com',993,'tls','smtp.gmail.com',465,'tls','b@gmail.com','oauth2','gmail')`)
    old.exec(`INSERT INTO folders(account_id,path,name) VALUES (1,'INBOX','INBOX'), (2,'INBOX','INBOX')`)
    old.close()
    const db2 = openDb(file)
    expect(db2.prepare('SELECT id, protocol, imap_host FROM accounts ORDER BY id').all()).toEqual([
      { id: 1, protocol: 'graph', imap_host: 'graph.microsoft.com' },
      { id: 2, protocol: 'imap', imap_host: 'imap.gmail.com' }
    ])
    expect(db2.prepare('SELECT account_id FROM folders').all()).toEqual([{ account_id: 2 }])
    db2.close()
  })
})
