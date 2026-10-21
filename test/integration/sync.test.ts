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
import { ExportManager } from '../../src/core/export/manager'
import type { CoreEvents, EventChannel } from '../../src/shared/ipc'

const srv = inject('testserver')
const USER = 'dana@doar.test'

let db: Db
let store: MailStore
let sync: SyncManager
let h: Handlers
let other: ImapFlow
let accountId: number
const events: { ch: string; data: unknown }[] = []

const otherClient = () =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user: USER, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

function msg(subject: string, body: string, extra = ''): Buffer {
  return Buffer.from(
    `From: =?UTF-8?Q?J=C3=A1n_Nov=C3=A1k?= <jan@firma.sk>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@firma.sk>\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\n${extra}${extra ? '' : 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n'}\r\n${body}\r\n`
  )
}

const HTML_MSG = Buffer.from(
  [
    'From: Newsletter <news@shop.sk>',
    `To: ${USER}`,
    'Subject: =?UTF-8?Q?Akcia_na_=C5=BElt=C3=A9_kone?=',
    'Message-ID: <html-1@shop.sk>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><h1 onclick="alert(1)">Ahoj</h1><script>alert("x")</script>',
    '<img src="https://tracker.example.com/pixel.gif"><img src="cid:logo@shop">',
    '<a href="javascript:alert(1)">zlé</a> <a href="https://shop.sk/akcia" target="_blank">dobré</a>',
    '<form action="https://evil"><input name=p></form><iframe src="https://evil"></iframe></body></html>',
    '--rel',
    'Content-Type: image/png',
    'Content-ID: <logo@shop>',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    '--rel--',
    ''
  ].join('\r\n')
)

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

const folderByPath = (p: string) => store.listFolders(accountId).find((f) => f.path === p)
const listOf = (path: string) => store.listMessages(folderByPath(path)!.id, 0, 500).items

beforeAll(async () => {
  other = otherClient()
  await other.connect()
  await other.mailboxCreate(['Faktúry', '2026'])
  await other.append('INBOX', msg('Prvá správa', 'Príliš žluťoučký kůň úpěl ďábelské ódy.'), ['\\Seen'])
  await other.append('INBOX', msg('Druhá správa', 'Obsah druhej správy'), [])
  await other.append('INBOX', HTML_MSG, [])
  await other.append('Faktúry/2026', msg('Faktúra 2026/001', 'Suma 120 €'), [])

  const dir = mkdtempSync(join(tmpdir(), 'doar-sync-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  const emit = <E extends EventChannel>(ch: E, data: CoreEvents[E]) => void events.push({ ch, data })
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit })
  h = createHandlers({
    db, blobs, store, sync, secrets,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }), sessionSecrets: new MemorySecrets(), emit,
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) },
    fetchRemote: async (urls) => new Map(urls.map((u) => [u, 'data:image/png;base64,AAAA']))
  })
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: USER, displayName: 'Dana', username: USER,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: true, providerKey: null
    },
    password: srv.password,
    rememberPassword: true
  })
  accountId = acc.id
  sync.start(accountId)
  await until(() => sync.get(accountId)!.status.lastSync !== null)
})

afterAll(async () => {
  await sync?.stopAll()
  await other?.logout()
})

describe('synchronizácia s IMAP serverom', () => {
  it('načíta priečinky: špeciálne podľa servera, vnorený priečinok s diakritikou', () => {
    const f = store.listFolders(accountId)
    const byUse = Object.fromEntries(f.filter((x) => x.specialUse).map((x) => [x.specialUse, x.path]))
    expect(byUse).toMatchObject({ inbox: 'INBOX', sent: 'Sent', drafts: 'Drafts', trash: 'Trash', junk: 'Junk', archive: 'Archive' })
    const nested = f.find((x) => x.path === 'Faktúry/2026')
    expect(nested).toMatchObject({ name: '2026', parentPath: 'Faktúry', depth: 1 })
    // Poradie: Doručená pošta prvá.
    expect(f[0]!.specialUse).toBe('inbox')
  })

  it('stiahne hlavičky a príznaky (prečítané/neprečítané) a počty neprečítaných', () => {
    const inbox = listOf('INBOX')
    expect(inbox.map((m) => m.subject).sort()).toEqual(['Akcia na žlté kone', 'Druhá správa', 'Prvá správa'].sort())
    expect(inbox.find((m) => m.subject === 'Prvá správa')!.seen).toBe(true)
    expect(inbox.find((m) => m.subject === 'Druhá správa')!.seen).toBe(false)
    expect(inbox.find((m) => m.subject === 'Prvá správa')!.fromName).toBe('Ján Novák')
    expect(folderByPath('INBOX')!.unread).toBe(2)
    expect(listOf('Faktúry/2026')[0]!.subject).toBe('Faktúra 2026/001')
  })

  it('na pozadí stiahne originály a zaindexuje ich (vyhľadávanie bez diakritiky)', async () => {
    await until(() => store.countNeedingBodies(accountId) === 0)
    expect(listOf('INBOX').every((m) => m.downloaded)).toBe(true)
    expect(listOf('INBOX').find((m) => m.subject === 'Prvá správa')!.snippet).toContain('žluťoučký')
    const hits = db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('zlutoucky')
    expect(hits).toHaveLength(1)
  })

  it('zobrazenie HTML správy: bez skriptov a formulárov, vzdialený obrázok blokovaný, cid obrázok vložený', async () => {
    const m = listOf('INBOX').find((x) => x.subject === 'Akcia na žlté kone')!
    const v = await h['messages.get']({ id: m.id })
    expect(v.html).not.toMatch(/<script|onclick|javascript:|<form|<iframe|tracker\.example\.com/i)
    expect(v.html).toContain('href="https://shop.sk/akcia"')
    expect(v.html).toContain('data:image/png;base64,')
    expect(v.remoteBlocked).toBe(1)
    expect(v.remoteShown).toBe(false)
    expect(v.attachments).toHaveLength(0) // vložený obrázok nie je príloha

    const shown = await h['messages.get']({ id: m.id, showRemote: true })
    expect(shown.remoteShown).toBe(true)
    expect(shown.remoteBlocked).toBe(0)
    expect(shown.html).not.toContain('tracker.example.com')
  })

  it('zmeny z iného klienta: prečítanie, zmazanie, nová správa', async () => {
    const lock = await other.getMailboxLock('INBOX')
    try {
      await other.messageFlagsAdd({ header: { subject: 'Druhá správa' } } as never, ['\\Seen']).catch(async () => {
        const uids = (await other.search({ subject: 'Druhá' }, { uid: true })) || []
        await other.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true })
      })
      const del = (await other.search({ subject: 'Prvá' }, { uid: true })) || []
      await other.messageDelete(del.join(','), { uid: true })
    } finally {
      lock.release()
    }
    await other.append('INBOX', msg('Tretia správa', 'Nová'), [])
    // IDLE spojenie má zmenu zachytiť samo, bez ručnej synchronizácie.
    await until(() => listOf('INBOX').some((m) => m.subject === 'Tretia správa'), 15_000)
    await sync.syncNow(accountId)
    const inbox = listOf('INBOX')
    expect(inbox.some((m) => m.subject === 'Prvá správa')).toBe(false)
    expect(inbox.find((m) => m.subject === 'Druhá správa')!.seen).toBe(true)
  })

  it('označenie ako prečítané v Doare sa prenesie na server', async () => {
    const m = listOf('INBOX').find((x) => x.subject === 'Tretia správa')!
    expect(m.seen).toBe(false)
    await h['messages.setFlags']({ ids: [m.id], seen: true, flagged: true })
    expect(listOf('INBOX').find((x) => x.id === m.id)!.seen).toBe(true) // hneď lokálne
    await until(() => listOf('INBOX').find((x) => x.id === m.id)!.localState === 'synced')
    const lock = await other.getMailboxLock('INBOX')
    try {
      const uids = (await other.search({ subject: 'Tretia' }, { uid: true })) || []
      const f = await other.fetchOne(String(uids[0]), { flags: true }, { uid: true })
      expect(f && f.flags && [...f.flags]).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']))
    } finally {
      lock.release()
    }
  })

  it('nová správa v priečinku, ktorý má Doar práve otvorený, sa nestratí (server ju ohlási až po príkaze)', async () => {
    // Pracovné spojenie má INBOX otvorený (po predošlej zmene príznakov).
    const before = listOf('INBOX').length
    await other.append('INBOX', msg('Počas otvoreného priečinka', 'x'), [])
    await sync.syncNow(accountId)
    expect(listOf('INBOX').length).toBe(before + 1)
    expect(listOf('INBOX').some((m) => m.subject === 'Počas otvoreného priečinka')).toBe(true)
  })

  it('zmena UIDVALIDITY (priečinok nahradený iným s rovnakým menom) → priečinok sa načíta znova', async () => {
    await other.mailboxCreate('Projekt')
    await other.append('Projekt', msg('Stará', 'x'), [])
    await sync.syncNow(accountId)
    expect(listOf('Projekt').map((m) => m.subject)).toEqual(['Stará'])
    await other.mailboxRename('Projekt', 'Projekt-zaloha')
    await other.mailboxCreate('Projekt')
    await other.append('Projekt', msg('Nová v novom priečinku', 'y'), [])
    await sync.syncNow(accountId)
    expect(listOf('Projekt').map((m) => m.subject)).toEqual(['Nová v novom priečinku'])
    expect(listOf('Projekt-zaloha').map((m) => m.subject)).toEqual(['Stará'])
  })

  it('priečinok zmazaný na serveri zmizne aj lokálne (pošta na serveri sa nemaže)', async () => {
    await other.mailboxDelete('Projekt-zaloha')
    await sync.syncNow(accountId)
    expect(folderByPath('Projekt-zaloha')).toBeUndefined()
  })

  it('stav synchronizácie a udalosti pre rozhranie', async () => {
    // Na pozadí sa môže ešte sťahovať obsah poslednej správy – počkáme.
    await until(() => sync.statuses()[0]?.state === 'idle' && store.countNeedingBodies(accountId) === 0)
    expect(sync.statuses()[0]).toMatchObject({ accountId, state: 'idle' })
    expect(events.some((e) => e.ch === 'folders.changed')).toBe(true)
    expect(events.some((e) => e.ch === 'messages.changed')).toBe(true)
  })
})
