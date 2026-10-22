import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
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
import { ImportManager } from '../../src/core/import/manager'
import { ArchiveManager } from '../../src/core/archive/archive'
import { OPEN_ATTACHMENTS_DIR } from '../../src/shared/ipc'

const srv = inject('testserver')
const USER = 'lenka@doar.test'
const TO = 'marek@doar.test'

let db: Db
let store: MailStore
let sync: SyncManager
let h: Handlers
let files: FileGrants
let accountId: number
let dir: string
let messageId: number

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256))])
const TXT = Buffer.from('Poznámky: žltý kôň úpel ďábelské ódy\n', 'utf8')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f00000000049454e44ae426082', 'hex')

const b64 = (b: Buffer) => b.toString('base64').replace(/.{76}/g, '$&\r\n')
const SOURCE = Buffer.from(
  [
    'From: Účtovníčka <uctovnicka@firma.sk>',
    `To: ${USER}`,
    'Subject: Faktúra a podklady',
    'Message-ID: <faktura-prilohy@firma.sk>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    '--mix',
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>V prílohe faktúra.</p><img src="cid:logo@firma">',
    '--rel',
    'Content-Type: image/png',
    'Content-ID: <logo@firma>',
    'Content-Transfer-Encoding: base64',
    '',
    b64(PNG),
    '--rel--',
    '--mix',
    'Content-Type: application/pdf; name="faktura.pdf"',
    'Content-Disposition: attachment; filename="faktura.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(PDF),
    '--mix',
    'Content-Type: text/plain; charset=utf-8',
    "Content-Disposition: attachment; filename*=UTF-8''pozn%C3%A1mky%20%C5%BElt%C3%A9.txt",
    'Content-Transfer-Encoding: base64',
    '',
    b64(TXT),
    '--mix',
    'Content-Type: application/octet-stream; name="setup.exe"',
    'Content-Disposition: attachment; filename="setup.exe"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.from('MZ fake')),
    '--mix--',
    ''
  ].join('\r\n')
)

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

async function received(user: string, subject: string): Promise<Buffer | null> {
  const c = imap(user)
  await c.connect()
  try {
    const lock = await c.getMailboxLock('INBOX')
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'doar-att-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  const c = imap(USER)
  await c.connect()
  await c.append('INBOX', SOURCE, [])
  await c.logout()
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: USER, displayName: 'Lenka', username: USER,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: false, providerKey: null
    },
    password: srv.password,
    rememberPassword: true
  })
  accountId = acc.id
  const emit = () => {}
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit })
  files = new FileGrants()
  h = createHandlers({
    files, db, blobs, store, sync, secrets,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }), sessionSecrets: new MemorySecrets(), emit,
    imports: new ImportManager({ db, store, blobs, emit, files: new FileGrants(), newClient: (id) => sync.newImapClient(id) }),
    archives: new ArchiveManager({ db, files: new FileGrants(), emit }),
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  sync.startAll()
  await until(() => sync.get(accountId)!.status.lastSync !== null && store.countNeedingBodies(accountId) === 0)
  const inbox = store.listFolders(accountId).find((f) => f.specialUse === 'inbox')!
  messageId = store.listMessages(inbox.id, 0, 10).items.find((m) => m.subject === 'Faktúra a podklady')!.id
})

afterAll(async () => {
  await sync?.stopAll()
})

describe('prílohy prijatej správy', () => {
  it('zoznam: bez vloženého obrázka (cid), s diakritikou v názve', async () => {
    const v = await h['messages.get']({ id: messageId })
    expect(v.attachments.map((a) => a.filename)).toEqual(['faktura.pdf', 'poznámky žlté.txt', 'setup.exe'])
    expect(v.attachments[0]!.size).toBe(PDF.length)
  })

  it('uložiť: len do súboru zvoleného v dialógu, obsah bajt po bajte', async () => {
    const target = join(dir, 'ulozene', 'moja-faktura.pdf')
    mkdirSync(join(dir, 'ulozene'))
    await expect(h['attachments.save']({ messageId, index: 0, path: target })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    expect(existsSync(target)).toBe(false)
    files.allow(target, 'write')
    await h['attachments.save']({ messageId, index: 0, path: target })
    expect(readFileSync(target).equals(PDF)).toBe(true)
    expect(readdirSync(join(dir, 'ulozene'))).toEqual(['moja-faktura.pdf']) // žiadny zvyšok .part
  })

  it('uložiť všetky: existujúci súbor sa neprepíše', async () => {
    const target = join(dir, 'vsetky')
    mkdirSync(target)
    writeFileSync(join(target, 'faktura.pdf'), 'pôvodný súbor')
    await expect(h['attachments.saveAll']({ messageId, dir: target })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    files.allow(target, 'dir')
    const { saved } = await h['attachments.saveAll']({ messageId, dir: target })
    expect(saved).toEqual(['faktura (2).pdf', 'poznámky žlté.txt', 'setup.exe'])
    expect(readFileSync(join(target, 'faktura.pdf'), 'utf8')).toBe('pôvodný súbor')
    expect(readFileSync(join(target, 'faktura (2).pdf')).equals(PDF)).toBe(true)
    expect(readFileSync(join(target, 'poznámky žlté.txt')).equals(TXT)).toBe(true)
  })

  it('otvoriť: dočasná kópia v dátovom priečinku; program (.exe) sa neotvorí nikdy', async () => {
    const { path } = await h['attachments.prepareOpen']({ messageId, index: 1 })
    expect(relative(join(dir, OPEN_ATTACHMENTS_DIR), path).startsWith('..')).toBe(false)
    expect(readFileSync(path).equals(TXT)).toBe(true)
    await expect(h['attachments.prepareOpen']({ messageId, index: 2 })).rejects.toMatchObject({ code: 'DANGEROUS_ATTACHMENT' })
    await expect(h['attachments.prepareOpen']({ messageId, index: 9 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('odoslanie s prílohami a preposlanie', () => {
  it('súbor z disku: len povolený, doručí sa nezmenený', async () => {
    const file = join(dir, 'Cenová ponuka 2026.pdf')
    writeFileSync(file, PDF)
    const base = { accountId, to: TO, cc: '', bcc: '', subject: 'Ponuka s prílohou', text: 'Posielam ponuku.', replyToMessage: null }
    await expect(h['compose.send']({ ...base, attachments: [{ kind: 'file', path: file }] })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    files.allow(file, 'read')
    await h['compose.send']({ ...base, attachments: [{ kind: 'file', path: file }] })
    let raw: Buffer | null = null
    await until(async () => (raw = await received(TO, 'Ponuka s prílohou')) !== null)
    const p = await simpleParser(raw!)
    expect(p.text?.trim()).toBe('Posielam ponuku.')
    expect(p.attachments).toHaveLength(1)
    expect(p.attachments[0]!.filename).toBe('Cenová ponuka 2026.pdf')
    expect(p.attachments[0]!.contentType).toBe('application/pdf')
    expect(p.attachments[0]!.content.equals(PDF)).toBe(true)
  })

  it('preposlanie: „Fwd:“, pôvodná hlavička a prílohy pôvodnej správy', async () => {
    const pre = await h['compose.prepare']({ mode: 'forward', messageId })
    expect(pre.subject).toBe('Fwd: Faktúra a podklady')
    expect(pre.to).toEqual([])
    expect(pre.replyToMessage).toBeNull()
    expect(pre.forward?.from[0]?.address).toBe('uctovnicka@firma.sk')
    expect(pre.forward?.text).toContain('V prílohe faktúra.')
    expect(pre.attachments.map((a) => a.filename)).toEqual(['faktura.pdf', 'poznámky žlté.txt', 'setup.exe'])
    // Používateľ odstráni setup.exe a pošle.
    await h['compose.send']({
      accountId, to: TO, cc: '', bcc: '', subject: pre.subject, text: 'Preposielam.\n\n---\nV prílohe faktúra.', replyToMessage: null,
      attachments: pre.attachments.filter((a) => a.filename !== 'setup.exe').map((a) => a.source)
    })
    let raw: Buffer | null = null
    await until(async () => (raw = await received(TO, 'Fwd: Faktúra a podklady')) !== null)
    const p = await simpleParser(raw!)
    expect(p.attachments.map((a) => a.filename)).toEqual(['faktura.pdf', 'poznámky žlté.txt'])
    expect(p.attachments[0]!.content.equals(PDF)).toBe(true)
    expect(p.attachments[1]!.content.equals(TXT)).toBe(true)
    expect(p.inReplyTo).toBeUndefined()
  })

  it('„Fwd:“ sa nezdvojí', async () => {
    const { forwardSubject } = await import('../../src/core/mail/compose')
    expect(forwardSubject('Fwd: Ahoj')).toBe('Fwd: Ahoj')
    expect(forwardSubject('FW: Ahoj')).toBe('FW: Ahoj')
    expect(forwardSubject('Re: Ahoj')).toBe('Fwd: Re: Ahoj')
  })

  it('príliš veľké prílohy sa odmietnu ešte pred odoslaním', async () => {
    const big = join(dir, 'velke.bin')
    writeFileSync(big, Buffer.alloc(51 * 1024 * 1024))
    files.allow(big, 'read')
    await expect(
      h['compose.send']({ accountId, to: TO, cc: '', bcc: '', subject: 'Veľké', text: '', replyToMessage: null, attachments: [{ kind: 'file', path: big }] })
    ).rejects.toMatchObject({ code: 'ATTACHMENTS_TOO_LARGE' })
    expect(store.outboxItems().some((o) => o.subject === 'Veľké')).toBe(false)
  })

  it('súbor medzičasom zmazaný → zrozumiteľná chyba', async () => {
    const gone = join(dir, 'zmazany.docx')
    files.allow(gone, 'read')
    await expect(
      h['compose.send']({ accountId, to: TO, cc: '', bcc: '', subject: 'Chýba', text: '', replyToMessage: null, attachments: [{ kind: 'file', path: gone }] })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' })
  })
})
