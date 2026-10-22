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

const srv = inject('testserver')
const FROM = 'filip@doar.test'

let db: Db
let store: MailStore
let blobs: BlobStore
let secrets: MemorySecrets
let sync: SyncManager
let h: Handlers
let accountId: number

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

/** Správy v priečinku iného používateľa (predmet + celý zdroj). */
async function mailbox(user: string, path = 'INBOX'): Promise<{ subject: string; source: string; flags: string[] }[]> {
  const c = imap(user)
  await c.connect()
  const out: { subject: string; source: string; flags: string[] }[] = []
  try {
    const lock = await c.getMailboxLock(path)
    try {
      if (c.mailbox && c.mailbox.exists > 0) {
        for await (const m of c.fetch('1:*', { envelope: true, source: true, flags: true })) {
          out.push({ subject: m.envelope?.subject ?? '', source: m.source?.toString('utf8') ?? '', flags: [...(m.flags ?? [])] })
        }
      }
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
  return out
}

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

const outbox = (id: number) => store.outboxRow(id)!

function newManager(): SyncManager {
  const emit = () => {}
  const m = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit })
  h = createHandlers({
    files: new FileGrants(),
    db, blobs, store, sync: m, secrets,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => m.newImapClient(id) }), sessionSecrets: new MemorySecrets(), emit,
    dataDir: '', appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  return m
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doar-send-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  blobs = new BlobStore(join(dir, 'blobs'))
  secrets = new MemorySecrets(true)
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: FROM, displayName: 'Filip Testovací', username: FROM,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: true, providerKey: null
    },
    password: srv.password,
    rememberPassword: true
  })
  accountId = acc.id
  sync = newManager()
  sync.startAll()
  await until(() => sync.get(accountId)!.status.lastSync !== null)
})

afterAll(async () => {
  await sync?.stopAll()
})

describe('odosielanie', () => {
  it('nová správa: doručená, skrytá kópia len v obálke, kópia v Odoslaných aj s Bcc', async () => {
    const { outboxId } = await h['compose.send']({
      accountId, to: 'Gita <gita@doar.test>', cc: '', bcc: 'bob@doar.test',
      subject: 'Pozdrav zo Žiliny', text: 'Ahoj Gita,\nako sa máš? Príliš žluťoučký kůň.\n\nFilip', replyToMessage: null
    })
    await until(() => outbox(outboxId).state === 'sent' && outbox(outboxId).sent_copy_state === 'done')

    const inbox = await mailbox('gita@doar.test')
    const got = inbox.find((m) => m.subject === 'Pozdrav zo Žiliny')!
    expect(got).toBeDefined()
    expect(got.source).not.toMatch(/^bcc:/im)
    expect(got.source).toMatch(/^From: =\?UTF-8\?Q\?Filip_Testovac=C3=AD\?= <filip@doar\.test>/im)
    expect(got.source).toMatch(/^Message-ID: <.+@doar\.test>/im)

    expect((await mailbox('bob@doar.test')).some((m) => m.subject === 'Pozdrav zo Žiliny')).toBe(true)

    const sent = (await mailbox(FROM, 'Sent')).find((m) => m.subject === 'Pozdrav zo Žiliny')!
    expect(sent.source).toMatch(/^Bcc: bob@doar\.test/im)
    expect(sent.flags).toContain('\\Seen')
    // Kópia v Odoslaných sa zobrazí aj v Doare.
    const sentFolder = store.listFolders(accountId).find((f) => f.specialUse === 'sent')!
    await until(() => store.listMessages(sentFolder.id, 0, 50).items.some((m) => m.subject === 'Pozdrav zo Žiliny'))
  })

  it('odpoveď: konto, adresát, „Re:“, In-Reply-To/References a príznak Odpovedané na serveri', async () => {
    const c = imap('gita@doar.test')
    await c.connect()
    await c.append('INBOX', Buffer.from('x'), []) // nič – len aby existovalo spojenie
    await c.logout()
    // Gita pošle Filipovi správu (cez SMTP), Filip odpovie všetkým.
    const g = imap(FROM)
    await g.connect()
    await g.append(
      'INBOX',
      Buffer.from('From: Gita <gita@doar.test>\r\nTo: filip@doar.test, emil@doar.test\r\nCc: dana@doar.test\r\nSubject: Stretnutie\r\nMessage-ID: <stretnutie-1@doar.test>\r\nReferences: <starsie@doar.test>\r\n\r\nPrídeš v piatok?\r\n'),
      []
    )
    await g.logout()
    await sync.syncNow(accountId)
    const inboxId = store.listFolders(accountId).find((f) => f.specialUse === 'inbox')!.id
    const orig = store.listMessages(inboxId, 0, 50).items.find((m) => m.subject === 'Stretnutie')!

    const pre = await h['compose.prepare']({ mode: 'replyAll', messageId: orig.id })
    expect(pre.accountId).toBe(accountId)
    expect(pre.subject).toBe('Re: Stretnutie')
    expect(pre.to.map((a) => a.address)).toEqual(['gita@doar.test'])
    expect(pre.cc.map((a) => a.address).sort()).toEqual(['dana@doar.test', 'emil@doar.test']) // bez vlastnej adresy
    expect(pre.quote?.text).toContain('Prídeš v piatok?')

    const { outboxId } = await h['compose.send']({
      accountId, to: 'gita@doar.test', cc: '', bcc: '', subject: pre.subject, text: 'Áno, prídem.', replyToMessage: orig.id
    })
    await until(() => outbox(outboxId).state === 'sent')
    const reply = (await mailbox('gita@doar.test')).find((m) => m.subject === 'Re: Stretnutie')!
    expect(reply.source).toMatch(/^In-Reply-To: <stretnutie-1@doar\.test>/im)
    expect(reply.source).toMatch(/^References: <starsie@doar\.test> <stretnutie-1@doar\.test>/im)
    await until(async () => (await mailbox(FROM)).find((m) => m.subject === 'Stretnutie')!.flags.includes('\\Answered'))
  })

  it('server odmietne adresáta → stav chyba, nič v Odoslaných', async () => {
    const { outboxId } = await h['compose.send']({ accountId, to: 'zlyhanie@doar.test', cc: '', bcc: '', subject: 'Odmietnutá', text: 'x', replyToMessage: null })
    await until(() => outbox(outboxId).state === 'error')
    expect(outbox(outboxId).error).toBe('REJECTED')
    expect((await mailbox(FROM, 'Sent')).some((m) => m.subject === 'Odmietnutá')).toBe(false)
  })

  it('neplatná adresa alebo žiadny adresát → odmietnuté ešte pred odoslaním', async () => {
    await expect(h['compose.send']({ accountId, to: 'nie-je-adresa', cc: '', bcc: '', subject: 'x', text: 'x', replyToMessage: null })).rejects.toMatchObject({ code: 'INVALID_RECIPIENTS' })
    await expect(h['compose.send']({ accountId, to: '', cc: '', bcc: '', subject: 'x', text: 'x', replyToMessage: null })).rejects.toMatchObject({ code: 'NO_RECIPIENTS' })
  })

  it('prerušenie po odoslaní obsahu → nejasný výsledok, správa sa NEODOŠLE znova', async () => {
    const before = (await mailbox('gita@doar.test')).filter((m) => m.subject === 'Možno odišla').length
    const { outboxId } = await h['compose.send']({ accountId, to: 'gita@doar.test, prijate-prerusenie@doar.test', cc: '', bcc: '', subject: 'Možno odišla', text: 'x', replyToMessage: null })
    await until(() => outbox(outboxId).state === 'uncertain')
    // Ďalšia synchronizácia ani spracovanie fronty ju nesmie poslať znova.
    await sync.syncNow(accountId)
    await sync.get(accountId)!.processOutboxNow()
    expect(outbox(outboxId).state).toBe('uncertain')
    expect((await mailbox('gita@doar.test')).filter((m) => m.subject === 'Možno odišla').length).toBe(before + 1)
    // Používateľ rozhodne: zahodiť.
    await h['outbox.resolve']({ id: outboxId, action: 'discard' })
    expect(store.outboxRow(outboxId)).toBeNull()
  })

  it('nejasný výsledok sa vyrieši sám, ak správu server uložil do Odoslaných (Message-ID)', async () => {
    const { outboxId } = await h['compose.send']({ accountId, to: 'prerusenie@doar.test', cc: '', bcc: '', subject: 'Uložil server', text: 'x', replyToMessage: null })
    await until(() => outbox(outboxId).state === 'uncertain')
    // Ako keby poskytovateľ (napr. Gmail) uložil odoslanú správu sám.
    const c = imap(FROM)
    await c.connect()
    await c.append('Sent', blobs.read(outbox(outboxId).blob_sha256), ['\\Seen'])
    await c.logout()
    // Po reštarte aplikácie Doar Odoslané skontroluje.
    await sync.stopAll()
    sync = newManager()
    sync.startAll()
    await until(() => outbox(outboxId).state === 'sent')
    expect(outbox(outboxId).sent_copy_state).toBe('done')
    expect((await mailbox(FROM, 'Sent')).filter((m) => m.subject === 'Uložil server')).toHaveLength(1) // žiadna druhá kópia
  })

  it('pád aplikácie počas odosielania → po spustení nejasný výsledok, nie automatické opakovanie', async () => {
    const { outboxId } = await h['compose.send']({ accountId, to: 'zlyhanie@doar.test', cc: '', bcc: '', subject: 'Pád', text: 'x', replyToMessage: null })
    await until(() => outbox(outboxId).state === 'error')
    store.setOutbox(outboxId, { state: 'sending' }) // simulácia: aplikácia spadla uprostred odosielania
    await sync.stopAll()
    sync = newManager()
    sync.startAll()
    await until(() => sync.get(accountId)!.status.lastSync !== null)
    expect(outbox(outboxId).state).toBe('uncertain')
    expect(outbox(outboxId).error).toBe('INTERRUPTED')
  })

  it('server neoznačí priečinok Odoslané → Doar ho založí (alebo použije existujúci) a kópiu uloží', async () => {
    // Dovecot v testoch Odoslané automaticky vytvára, preto simulujeme server bez SPECIAL-USE: Doar o Odoslaných nevie.
    db.prepare(`UPDATE folders SET special_use = NULL WHERE account_id = ? AND special_use = 'sent'`).run(accountId)
    expect(store.listFolders(accountId).some((f) => f.specialUse === 'sent')).toBe(false)
    const { outboxId } = await h['compose.send']({ accountId, to: 'gita@doar.test', cc: '', bcc: '', subject: 'Do nového Odoslaných', text: 'x', replyToMessage: null })
    await until(() => outbox(outboxId).sent_copy_state === 'done')
    expect((await mailbox(FROM, 'Sent')).some((m) => m.subject === 'Do nového Odoslaných')).toBe(true)
    expect(store.listFolders(accountId).find((f) => f.specialUse === 'sent')?.path).toBe('Sent')
  })

  it('zoznam pre rozhranie: odoslané a dokončené sa nezobrazujú, problémové áno', () => {
    const items = store.outboxItems()
    expect(items.every((i) => i.state !== 'sent' || i.sentCopyState === 'pending' || i.sentCopyState === 'failed')).toBe(true)
    expect(items.some((i) => i.subject === 'Odmietnutá' && i.state === 'error')).toBe(true)
  })
})
