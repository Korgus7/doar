import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'
import { createHandlers, ruleActions, type Handlers } from '../../src/core/handlers'
import { applyRules } from '../../src/core/rules'
import { FileGrants } from '../../src/core/files'
import { ExportManager } from '../../src/core/export/manager'
import { ImportManager } from '../../src/core/import/manager'
import { ArchiveManager } from '../../src/core/archive/archive'

/** Pravidlá pre novú poštu, odoslať neskôr, označiť priečinok ako prečítaný – proti testovaciemu serveru. */

const srv = inject('testserver')
const USER = 'carol@doar.test'

let db: Db
let store: MailStore
let sync: SyncManager
let h: Handlers
let other: ImapFlow
let accountId: number
const notices: { messageIds: number[] }[] = []
const grants = new FileGrants()

const client = (): ImapFlow =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user: USER, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

function msg(subject: string, from: string): Buffer {
  return Buffer.from(
    `From: ${from}\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText\r\n`
  )
}

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

const folder = (p: string) => store.listFolders(accountId).find((f) => f.path === p)!
const listOf = (p: string) => store.listMessages(folder(p).id, 0, 500).items

/** Predmet → dátum z hlavičky (obálka) v priečinku na serveri. */
async function serverDates(path: string): Promise<Map<string, number | undefined>> {
  const c = client()
  await c.connect()
  try {
    const lock = await c.getMailboxLock(path)
    try {
      const out = new Map<string, number | undefined>()
      for await (const m of c.fetch('1:*', { envelope: true })) out.set(m.envelope?.subject ?? '', (m.envelope?.date ? new Date(m.envelope.date).getTime() : undefined))
      return out
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
}

/** Predmety v priečinku na serveri – vždy nové spojenie (otvorený priečinok by ukazoval starý stav). */
async function serverSubjects(path: string): Promise<string[]> {
  const c = client()
  await c.connect()
  try {
    const lock = await c.getMailboxLock(path)
    try {
      if (!c.mailbox || !c.mailbox.exists) return []
      const out: string[] = []
      for await (const m of c.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '')
      return out
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
}

beforeAll(async () => {
  other = client()
  await other.connect()
  await other.mailboxCreate('Novinky')
  await other.append('INBOX', msg('Stará novinka', 'Obchod <novinky@obchod.sk>'), [])

  const dir = mkdtempSync(join(tmpdir(), 'doar-rules-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  const emit = () => {}
  sync = new SyncManager({
    db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit,
    undoDelayMs: 300,
    onNewMail: (n) => void notices.push(n),
    onArrived: ({ messageIds }) => applyRules(db, store, ruleActions({ sync }), messageIds).handled
  })
  h = createHandlers({
    files: grants,
    db, blobs, store, sync, secrets,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }), sessionSecrets: new MemorySecrets(), emit,
    imports: new ImportManager({ db, store, blobs, emit, files: new FileGrants(), newClient: (id) => sync.newImapClient(id) }),
    archives: new ArchiveManager({ db, files: new FileGrants(), emit }),
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: USER, displayName: 'Carol', username: USER,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: false, providerKey: null
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

describe('pravidlá pre novú poštu', () => {
  it('nová pošta: presun do priečinka na serveri, bez oznámenia; ostatná pošta sa oznámi', async () => {
    await h['rules.save']({ name: 'Novinky', enabled: true, accountId, field: 'from', value: 'obchod.sk', action: 'move', folderId: folder('Novinky').id })
    // Pri prvom načítaní sa pravidlá nepoužili – stará novinka ostala v doručenej pošte.
    expect(listOf('INBOX').some((m) => m.subject === 'Stará novinka')).toBe(true)

    await other.append('INBOX', msg('Zľava 50 %', 'Obchod Šťastný <novinky@obchod.sk>'), [])
    await other.append('INBOX', msg('Obed zajtra', 'Ján <jan@firma.sk>'), [])
    await sync.syncNow(accountId)

    expect(listOf('INBOX').some((m) => m.subject === 'Zľava 50 %')).toBe(false)
    expect(listOf('Novinky').some((m) => m.subject === 'Zľava 50 %')).toBe(true)
    const notified = notices.flatMap((n) => n.messageIds).map((id) => store.message(id)?.subject)
    expect(notified).toContain('Obed zajtra')
    expect(notified).not.toContain('Zľava 50 %')
    // Po čase na „Vrátiť späť“ je presun aj na serveri.
    await until(async () => (await serverSubjects('Novinky')).includes('Zľava 50 %'))
    expect(await serverSubjects('INBOX')).not.toContain('Zľava 50 %')
  })

  it('„Použiť pravidlá na priečinok“ spracuje aj staršiu poštu', async () => {
    const r = await h['rules.run']({ folderId: folder('INBOX').id })
    expect(r.applied).toBe(1)
    await until(async () => (await serverSubjects('Novinky')).includes('Stará novinka'))
  })

  it('označiť všetko ako prečítané (aj na serveri)', async () => {
    await other.append('INBOX', msg('Neprečítaná 1', 'a@b.sk'), [])
    await other.append('INBOX', msg('Neprečítaná 2', 'a@b.sk'), [])
    await sync.syncNow(accountId)
    const r = await h['messages.markFolderRead']({ folderId: folder('INBOX').id })
    expect(r.count).toBeGreaterThanOrEqual(2)
    expect(listOf('INBOX').every((m) => m.seen)).toBe(true)
    expect((await h['messages.markFolderRead']({ folderId: folder('INBOX').id })).count).toBe(0)
    await until(async () => {
      const lock = await other.getMailboxLock('INBOX')
      try {
        return ((await other.search({ seen: false }, { uid: true })) || []).length === 0
      } finally {
        lock.release()
      }
    })
  })
})

describe('konverzácie', () => {
  it('odpoveď z Doaru sa pripojí ku konverzácii; v zozname jeden riadok, pri čítaní obe správy', async () => {
    await other.append('INBOX', Buffer.from(`From: Ján <jan@firma.sk>\r\nTo: ${USER}\r\nSubject: Porada\r\nMessage-ID: <porada-1@firma.sk>\r\nDate: ${new Date(Date.now() - 3_600_000).toUTCString()}\r\nContent-Type: text/plain\r\n\r\nKedy?\r\n`), ['\\Seen'])
    await sync.syncNow(accountId)
    const original = listOf('INBOX').find((m) => m.subject === 'Porada')!
    // Odpoveď si Doar pošle sám sebe – príde do doručenej pošty s In-Reply-To.
    const { outboxId } = await h['compose.send']({ accountId, to: USER, cc: '', bcc: '', subject: 'Re: Porada', text: 'Zajtra o 9.', replyToMessage: original.id })
    await until(() => store.outboxRow(outboxId)!.state === 'sent')
    await until(async () => (await serverSubjects('INBOX')).includes('Re: Porada'))
    await sync.syncNow(accountId)
    const rows = (await h['messages.list']({ folderId: folder('INBOX').id, offset: 0, limit: 200, threads: true })).items
    const conv = rows.find((m) => m.subject === 'Re: Porada')!
    expect(conv.threadIds).toHaveLength(2)
    expect(rows.some((m) => m.subject === 'Porada')).toBe(false)
    expect((await h['messages.thread']({ id: conv.id })).map((m) => m.id).sort()).toEqual([...conv.threadIds!].sort())
    // Prečítané pre celú konverzáciu.
    await h['messages.setFlags']({ ids: conv.threadIds!, seen: true })
    expect((await h['messages.list']({ folderId: folder('INBOX').id, offset: 0, limit: 200, threads: true })).items.find((m) => m.id === conv.id)!.seen).toBe(true)
    // „Vybrať všetko“ po konverzáciách.
    expect(await h['messages.listIds']({ folderId: folder('INBOX').id, threads: true })).toContain(conv.id)
    expect(await h['messages.listIds']({ folderId: folder('INBOX').id, threads: true })).not.toContain(original.id)
  })
})

describe('odoslať neskôr', () => {
  it('naplánovaná správa čaká; „Odoslať hneď“ ju odošle s naplánovaným dátumom v hlavičke', async () => {
    const at = new Date(Date.now() + 3_600_000)
    at.setSeconds(0, 0)
    const { outboxId } = await h['compose.send']({ accountId, to: USER, cc: '', bcc: '', subject: 'Naplánovaná', text: 'neskôr', replyToMessage: null, sendAt: at.toISOString() })
    await sync.get(accountId)!.processOutboxNow()
    expect(store.outboxRow(outboxId)).toMatchObject({ state: 'queued', send_at: at.toISOString() })
    expect(store.countPendingChanges(accountId)).toBe(0)
    await h['outbox.scheduled']({ id: outboxId, action: 'sendNow' })
    await until(() => store.outboxRow(outboxId)!.state === 'sent')
    await until(async () => (await serverSubjects('INBOX')).includes('Naplánovaná'))
    expect((await serverDates('INBOX')).get('Naplánovaná')).toBe(at.getTime())
  })

  it('správa sa odošle sama, keď príde jej čas', async () => {
    const { outboxId } = await h['compose.send']({ accountId, to: USER, cc: '', bcc: '', subject: 'Sama o chvíľu', text: 'x', replyToMessage: null, sendAt: new Date(Date.now() + 3_600_000).toISOString() })
    store.setOutboxSendAt(outboxId, new Date(Date.now() + 1500).toISOString())
    await sync.get(accountId)!.processOutboxNow()
    expect(store.outboxRow(outboxId)!.state).toBe('queued')
    await until(() => store.outboxRow(outboxId)!.state === 'sent', 15_000)
  })

  it('zrušenie: správa sa vráti medzi koncepty aj s adresátmi a prílohou', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doar-att-'))
    const file = join(dir, 'zmluva.txt')
    writeFileSync(file, 'obsah zmluvy')
    grants.allow(file, 'read')
    const { outboxId } = await h['compose.send']({
      accountId, to: 'Ema <ema@doar.test>', cc: '', bcc: 'tajne@doar.test', subject: 'Zrušená', text: 'Ahoj', html: '<p>Ahoj <b>Ema</b></p>', replyToMessage: null,
      attachments: [{ kind: 'file', path: file }],
      sendAt: new Date(Date.now() + 86_400_000).toISOString()
    })
    const { draftId } = await h['outbox.scheduled']({ id: outboxId, action: 'cancel' })
    expect(store.outboxRow(outboxId)).toBeNull()
    const d = store.draft(draftId!)!
    const data = JSON.parse(d.data_json) as { to: string; bcc: string; subject: string; html: string | null }
    expect(data).toMatchObject({ to: 'Ema <ema@doar.test>', bcc: 'tajne@doar.test', subject: 'Zrušená' })
    expect(data.html).toContain('<b>Ema</b>')
    expect(JSON.parse(d.attachments_json)).toEqual([expect.objectContaining({ name: 'zmluva.txt', size: 12 })])
    // Odoslanie hneď alebo zrušenie už zrušenej → chyba.
    await expect(h['outbox.scheduled']({ id: outboxId, action: 'sendNow' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('neplatný čas odoslania sa odmietne; čas v minulosti = hneď', async () => {
    await expect(
      h['compose.send']({ accountId, to: USER, cc: '', bcc: '', subject: 'x', text: 'x', replyToMessage: null, sendAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })
    ).rejects.toMatchObject({ code: 'INVALID_SEND_AT' })
    const { outboxId } = await h['compose.send']({ accountId, to: USER, cc: '', bcc: '', subject: 'Hneď', text: 'x', replyToMessage: null, sendAt: new Date(Date.now() - 60_000).toISOString() })
    expect(store.outboxRow(outboxId)!.send_at).toBeNull()
    await until(() => store.outboxRow(outboxId)!.state === 'sent')
  })
})
