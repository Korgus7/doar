import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'
import { createHandlers, type Handlers } from '../../src/core/handlers'
import { FileGrants } from '../../src/core/files'
import { ExportManager } from '../../src/core/export/manager'

const srv = inject('testserver')
const USER = 'vlado@doar.test'
const TO = 'zuzana@doar.test'

let db: Db
let store: MailStore
let sync: SyncManager
let h: Handlers
let accountId: number

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

async function find(user: string, path: string, subject: string): Promise<Buffer | null> {
  const c = imap(user)
  await c.connect()
  try {
    const lock = await c.getMailboxLock(path)
    try {
      if (!c.mailbox || !c.mailbox.exists) return null
      for await (const m of c.fetch('1:*', { envelope: true, source: true })) if (m.envelope?.subject === subject) return m.source ?? null
      return null
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

beforeAll(async () => {
  const c = imap(USER)
  await c.connect()
  await c.append('INBOX', Buffer.from(`From: Ľubomír Šťastný <lubo@stastny.sk>\r\nTo: ${USER}\r\nSubject: Ahoj\r\n\r\nx\r\n`), [])
  await c.append('INBOX', Buffer.from(`From: Ľubomír Šťastný <lubo@stastny.sk>\r\nTo: ${USER}\r\nSubject: Ahoj 2\r\n\r\nx\r\n`), [])
  await c.logout()
  const dir = mkdtempSync(join(tmpdir(), 'doar-html-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  accountId = (
    await addAccount(db, secrets, secrets, {
      settings: {
        email: USER, displayName: 'Vlado', username: USER,
        imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
        smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
        saveSentCopy: false, providerKey: null
      },
      password: srv.password,
      rememberPassword: true
    })
  ).id
  const emit = () => {}
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit, draftDelayMs: 300 })
  h = createHandlers({
    files: new FileGrants(), db, blobs, store, sync, secrets, sessionSecrets: new MemorySecrets(), emit,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }),
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  sync.startAll()
  await until(() => sync.get(accountId)!.status.lastSync !== null)
})

afterAll(async () => {
  await sync?.stopAll()
})

const HTML = '<p>Dobrý deň,</p><p>posielam <strong>ponuku</strong> a <a href="https://firma.sk/cennik">cenník</a>.</p><ul><li><p>stoly</p></li><li><p>stoličky</p></li></ul><p>-- <br>Vlado</p><script>alert(1)</script>'

describe('formátovaná správa', () => {
  it('odíde ako HTML aj text (multipart/alternative), bez nebezpečného obsahu', async () => {
    await h['compose.send']({ accountId, to: 'Zuzana Nováková <zuzana@doar.test>', cc: '', bcc: '', subject: 'Formátovaná ponuka', text: 'ignorované', html: HTML, replyToMessage: null })
    let raw: Buffer | null = null
    await until(async () => (raw = await find(TO, 'INBOX', 'Formátovaná ponuka')) !== null)
    expect(raw!.toString()).toMatch(/Content-Type: multipart\/alternative/i)
    const p = await simpleParser(raw!)
    expect(p.html).toContain('<strong>ponuku</strong>')
    expect(p.html).toContain('<a href="https://firma.sk/cennik">cenník</a>')
    expect(p.html).not.toMatch(/script|alert/)
    expect(p.text?.trim()).toBe('Dobrý deň,\n\nposielam ponuku a cenník <https://firma.sk/cennik>.\n\n- stoly\n- stoličky\n\n-- \nVlado')
  })

  it('čistý text odíde ako čistý text', async () => {
    await h['compose.send']({ accountId, to: TO, cc: '', bcc: '', subject: 'Len text', text: 'Ahoj *tučne*', html: null, replyToMessage: null })
    let raw: Buffer | null = null
    await until(async () => (raw = await find(TO, 'INBOX', 'Len text')) !== null)
    expect(raw!.toString()).not.toMatch(/text\/html/i)
    expect((await simpleParser(raw!)).text?.trim()).toBe('Ahoj *tučne*')
  })

  it('koncept si formátovanie pamätá (lokálne aj na serveri)', async () => {
    const { draftId } = await h['drafts.save']({ draftId: null, accountId, to: TO, cc: '', bcc: '', subject: 'Formátovaný koncept', text: '', html: HTML, replyToMessage: null, attachments: [], flush: true })
    let raw: Buffer | null = null
    await until(async () => (raw = await find(USER, 'Drafts', 'Formátovaný koncept')) !== null)
    expect((await simpleParser(raw!)).html).toContain('<strong>ponuku</strong>')
    const drafts = store.listFolders(accountId).find((f) => f.specialUse === 'drafts')!
    await until(() => store.listMessages(drafts.id, 0, 10).items.length === 1)
    const pre = await h['compose.prepare']({ mode: 'draft', messageId: store.listMessages(drafts.id, 0, 10).items[0]!.id })
    expect(pre.draftId).toBe(draftId)
    expect(pre.draft?.html).toContain('<strong>ponuku</strong>')
    expect(pre.draft?.html).not.toContain('script')
  })
})

describe('návrhy adries', () => {
  it('komu som písal (aj s menom) aj od koho mám poštu; bez diakritiky, od začiatku slova', async () => {
    expect(await h['addresses.suggest']({ query: 'zuz' })).toEqual([{ name: 'Zuzana Nováková', address: 'zuzana@doar.test' }])
    expect((await h['addresses.suggest']({ query: 'novak' }))[0]?.address).toBe('zuzana@doar.test')
    expect(await h['addresses.suggest']({ query: 'stast' })).toEqual([{ name: 'Ľubomír Šťastný', address: 'lubo@stastny.sk' }])
    expect(await h['addresses.suggest']({ query: 'ľubo' })).toHaveLength(1)
    expect(await h['addresses.suggest']({ query: 'ovak' })).toEqual([]) // nie zo stredu slova
    expect(await h['addresses.suggest']({ query: '' })).toEqual([])
  })
})
