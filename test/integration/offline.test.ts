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
const USER = 'xaver@doar.test'
const TO = 'yvona@doar.test'

let dir: string
let db: Db
let store: MailStore
let blobs: BlobStore
let secrets: MemorySecrets
let sync: SyncManager
let h: Handlers
let accountId: number

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

async function folder(user: string, path: string): Promise<{ subject: string; flags: string[] }[]> {
  const c = imap(user)
  await c.connect()
  try {
    const lock = await c.getMailboxLock(path)
    try {
      if (!c.mailbox || !c.mailbox.exists) return []
      const out: { subject: string; flags: string[] }[] = []
      for await (const m of c.fetch('1:*', { envelope: true, flags: true })) out.push({ subject: m.envelope?.subject ?? '', flags: [...(m.flags ?? [])] })
      return out
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
}

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

/** „Spustenie aplikácie“: nový správca synchronizácie nad tou istou databázou (fronta prežije reštart). */
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
function setOnline(online: boolean): void {
  db.prepare('UPDATE accounts SET imap_port = ?, smtp_port = ? WHERE id = ?').run(online ? srv.ports.imaps : 1, online ? srv.ports.smtps : 1, accountId)
}

const inbox = () => store.listFolders(accountId).find((f) => f.specialUse === 'inbox')!
const items = () => store.listMessages(inbox().id, 0, 50).items
const status = () => sync.statuses().find((s) => s.accountId === accountId)!

beforeAll(async () => {
  const c = imap(USER)
  await c.connect()
  for (const s of ['Prečítam bez siete', 'Do koša bez siete', 'Hviezdička bez siete']) {
    await c.append('INBOX', Buffer.from(`From: jan@firma.sk\r\nTo: ${USER}\r\nSubject: ${s}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText správy: ${s}\r\n`), [])
  }
  await c.logout()
  dir = mkdtempSync(join(tmpdir(), 'doar-offline-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  blobs = new BlobStore(join(dir, 'blobs'))
  secrets = new MemorySecrets(true)
  accountId = (
    await addAccount(db, secrets, secrets, {
      settings: {
        email: USER, displayName: 'Xaver', username: USER,
        imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
        smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
        saveSentCopy: true, providerKey: null
      },
      password: srv.password,
      rememberPassword: true
    })
  ).id
  startApp()
  await until(() => status().lastSync !== null && store.countNeedingBodies(accountId) === 0)
})

afterAll(async () => {
  await sync?.stopAll()
})

describe('bez pripojenia', () => {
  it('čítanie, vyhľadávanie, zmeny, koncept a odoslanie fungujú; všetko čaká vo fronte', async () => {
    await sync.stopAll()
    setOnline(false)
    startApp()
    await until(() => status().state === 'offline')

    // Čítanie a vyhľadávanie z lokálnej kópie.
    const read = items().find((m) => m.subject === 'Prečítam bez siete')!
    expect((await h['messages.get']({ id: read.id })).text).toContain('Text správy')
    expect((await h['messages.search']({ query: 'hviezdicka', offset: 0, limit: 10 })).total).toBe(1)

    // Zmeny – hneď viditeľné lokálne.
    await h['messages.setFlags']({ ids: [read.id], seen: true })
    await h['messages.setFlags']({ ids: [items().find((m) => m.subject === 'Hviezdička bez siete')!.id], flagged: true })
    await h['messages.move']({ ids: [items().find((m) => m.subject === 'Do koša bez siete')!.id], special: 'trash' })
    expect(items().map((m) => m.subject).sort()).toEqual(['Hviezdička bez siete', 'Prečítam bez siete'])

    // Koncept a odoslanie.
    await h['drafts.save']({ draftId: null, accountId, to: TO, cc: '', bcc: '', subject: 'Koncept bez siete', text: 'x', html: null, replyToMessage: null, attachments: [], flush: true })
    const { outboxId } = await h['compose.send']({ accountId, to: TO, cc: '', bcc: '', subject: 'Odoslané bez siete', text: 'Ahoj', replyToMessage: null })
    // Bez pripojenia správa zostane vo fronte (nie „chyba“) – nič neodišlo, odošle sa sama.
    await until(() => store.outboxRow(outboxId)!.error === 'OFFLINE')
    expect(store.outboxRow(outboxId)!.state).toBe('queued')
    await until(() => status().pendingChanges >= 5)
  })

  it('fronta prežije reštart aplikácie a po pripojení sa všetko vykoná', async () => {
    // Reštart stále bez siete.
    await sync.stopAll()
    startApp()
    await until(() => status().state === 'offline')
    expect(status().pendingChanges).toBeGreaterThanOrEqual(5)

    // Sieť je späť.
    setOnline(true)
    await sync.stopAll() // nové nastavenia sa načítajú pri štarte (ako po zmene siete v aplikácii)
    startApp()
    sync.reconnectAll()
    await until(async () => (await folder(TO, 'INBOX')).some((m) => m.subject === 'Odoslané bez siete'), 30_000)
    await until(async () => (await folder(USER, 'Trash')).some((m) => m.subject === 'Do koša bez siete'))
    await until(async () => (await folder(USER, 'Drafts')).some((m) => m.subject === 'Koncept bez siete'))
    await until(async () => (await folder(USER, 'Sent')).some((m) => m.subject === 'Odoslané bez siete'))
    const box = await folder(USER, 'INBOX')
    expect(box.find((m) => m.subject === 'Prečítam bez siete')!.flags).toContain('\\Seen')
    expect(box.find((m) => m.subject === 'Hviezdička bez siete')!.flags).toContain('\\Flagged')
    await until(() => status().pendingChanges === 0)
    // Správa odišla práve raz.
    expect((await folder(TO, 'INBOX')).filter((m) => m.subject === 'Odoslané bez siete')).toHaveLength(1)
  })
})
