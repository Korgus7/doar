import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ImapFlow } from 'imapflow'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'
import { ExportManager } from '../../src/core/export/manager'
import { realFs, type FsOps } from '../../src/core/export/export-account'
import { canonicalize, sha256, splitMboxrd, stripDoarBlock } from '../../src/core/export/mboxrd'
import type { ExportSummary } from '../../src/shared/ipc'

const srv = inject('testserver')
const USER = 'hana@doar.test'
const outDir = mkdtempSync(join(tmpdir(), 'doar-export-out-'))

const imap = () =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user: USER, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

const ATTACHMENT = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256))

function plain(subject: string, body: string, extra = ''): Buffer {
  return Buffer.from(
    `Return-Path: <jan@firma.sk>\r\nFrom: Jan <jan@firma.sk>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@firma.sk>\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`,
    'utf8'
  )
}

const WITH_ATTACHMENT = Buffer.from(
  [
    'From: Eva <eva@firma.sk>',
    `To: ${USER}`,
    'Subject: =?UTF-8?Q?Zmluva_=E2=80=93_pr=C3=ADloha?=',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'V prílohe zmluva.',
    '--b1',
    'Content-Type: application/pdf; name="zmluva.pdf"',
    'Content-Disposition: attachment; filename="zmluva.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    ...(ATTACHMENT.toString('base64').match(/.{1,76}/g) ?? []),
    '--b1--',
    ''
  ].join('\r\n')
)

/** Správy na serveri: priečinok → [{ predmet, kanonický hash, interný dátum }]. */
const server = new Map<string, { subject: string; hash: string; date: string; flags: string[] }[]>()

async function readServer(): Promise<void> {
  server.clear()
  const c = imap()
  await c.connect()
  for (const f of await c.list()) {
    if (f.flags.has('\\Noselect') || f.flags.has('\\NonExistent')) continue
    const lock = await c.getMailboxLock(f.path, { readOnly: true })
    try {
      const list: { subject: string; hash: string; date: string; flags: string[] }[] = []
      if (c.mailbox && c.mailbox.exists) {
        for await (const m of c.fetch('1:*', { envelope: true, source: true, internalDate: true, flags: true })) {
          list.push({
            subject: m.envelope?.subject ?? '',
            hash: sha256(canonicalize(m.source!)),
            date: new Date(m.internalDate!).toISOString(),
            flags: [...(m.flags ?? [])].filter((x) => x !== '\\Recent').sort()
          })
        }
      }
      server.set(f.path, list)
    } finally {
      lock.release()
    }
  }
  await c.logout()
}

interface Ctx {
  db: Db
  store: MailStore
  sync: SyncManager
  exports: ExportManager
  accountId: number
}

async function makeCtx(opts: { fs?: FsOps; afterSnapshot?: (ctx: Ctx) => Promise<void> } = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'doar-export-'))
  const db = openDb(join(dir, 'doar.db'))
  const store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  const emit = () => {}
  const sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit })
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: USER, displayName: 'Hana', username: USER,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: true, providerKey: null
    },
    password: srv.password,
    rememberPassword: true
  })
  const ctx = {} as Ctx
  const exports = new ExportManager(
    { db, store, blobs, emit, fs: opts.fs, newClient: (id) => sync.newImapClient(id) },
    { afterSnapshot: opts.afterSnapshot ? () => opts.afterSnapshot!(ctx) : undefined }
  )
  Object.assign(ctx, { db, store, sync, exports, accountId: acc.id })
  return ctx
}

async function runExport(ctx: Ctx, name: string): Promise<{ summary: ExportSummary; path: string }> {
  const path = join(outDir, name)
  ctx.exports.allow(path)
  const { jobId } = ctx.exports.start(ctx.accountId, path)
  const summary = (await ctx.exports.wait(jobId))!
  return { summary, path }
}

beforeAll(async () => {
  const c = imap()
  await c.connect()
  await c.mailboxCreate(['Faktúry', '2026'])
  await c.mailboxCreate('Plán & návrhy')
  await c.append('INBOX', plain('Prvá – s hviezdičkou', 'Ahoj,\r\nFrom the beginning\r\n>From x\r\nKoniec\r\n'), ['\\Seen', '\\Flagged'], new Date('2026-09-01T08:00:00Z'))
  await c.append('INBOX', WITH_ATTACHMENT, [], new Date('2026-09-02T09:30:00Z'))
  await c.append('INBOX', plain('Odpovedaná', 'Text\r\n'), ['\\Seen', '\\Answered', '$Forwarded'], new Date('2026-09-03T10:00:00Z'))
  await c.append('INBOX', plain('Bez konca riadku', 'posledny riadok bez CRLF'), [], new Date('2026-09-04T11:00:00Z'))
  await c.append('Sent', plain('Odoslaná', 'x\r\n'), ['\\Seen'], new Date('2026-09-05T12:00:00Z'))
  await c.append('Faktúry/2026', plain('Faktúra 001', 'Suma 120 €\r\n'), ['\\Seen'], new Date('2026-09-06T13:00:00Z'))
  await c.append('Faktúry/2026', plain('Faktúra 002', 'Suma 80 €\r\n'), [], new Date('2026-09-07T14:00:00Z'))
  await c.append('Plán & návrhy', plain('Plán', 'Hotovo\r\n'), [], new Date('2026-09-08T15:00:00Z'))
  await c.logout()
  await readServer()
})

afterAll(() => {})

describe('záloha konta do mbox', () => {
  let ctx: Ctx
  let first: { summary: ExportSummary; path: string }

  it('úplná záloha bez lokálnej kópie: stiahne všetko, súbor bez .part, súhrn po priečinkoch', async () => {
    ctx = await makeCtx()
    first = await runExport(ctx, 'Doar-hana.mbox')
    const s = first.summary
    expect(s.result).toBe('complete')
    expect(s.path).toBe(first.path)
    expect(s.totals).toEqual({ expected: 8, exported: 8, unavailable: 0, failed: 0 })
    expect(s.downloaded).toBe(8)
    expect(s.sizeBytes).toBeGreaterThan(0)
    expect(readdirSync(outDir).filter((f) => f.endsWith('.part'))).toEqual([])
    const byPath = Object.fromEntries(s.folders.map((f) => [f.path, f.exported]))
    expect(byPath).toMatchObject({ INBOX: 4, Sent: 1, 'Faktúry / 2026': 2, 'Plán & návrhy': 1, Drafts: 0, Trash: 0 })
    expect(s.folders[0]!.path).toBe('INBOX')
  })

  it('obsah súboru: originály bit po bite, priečinky, dátumy, príznaky, mboxrd', () => {
    const data = readFileSync(first.path)
    const text = data.toString('latin1')
    expect(text).toContain('\n>From the beginning\n>>From x\n')
    expect(text).not.toContain('\r')
    const entries = splitMboxrd(data).map((e) => stripDoarBlock(e.message))
    expect(entries).toHaveLength(8)
    expect(entries.every((e) => e.block && e.hashOk)).toBe(true)

    const pathOf = (segs: string[]) => segs.join('/')
    for (const [folder, msgs] of server) {
      const exported = entries.filter((e) => pathOf(e.block!.folderSegments) === folder)
      expect(exported.map((e) => e.block!.hash).sort(), folder).toEqual(msgs.map((m) => m.hash).sort())
      for (const m of msgs) {
        const e = exported.find((x) => x.block!.hash === m.hash)!
        expect(e.block!.internalDate?.toISOString()).toBe(m.date)
        expect([...e.block!.flags].sort()).toEqual(m.flags)
      }
    }
    const first0 = entries.find((e) => e.original.toString().includes('Prvá'))!
    expect(first0.block!.headers.get('status')).toBe('RO')
    expect(first0.block!.headers.get('x-status')).toBe('F')
    expect(first0.block!.specialUse).toBe('\\Inbox')
    const answered = entries.find((e) => e.original.toString().includes('Odpovedan'))!
    expect(answered.block!.headers.get('x-status')).toBe('A')
    expect(answered.block!.headers.get('x-doar-keywords')).toBe('$Forwarded')
    expect(text).toContain('X-Doar-Folder: Fakt%C3%BAry/2026\n')
    expect(text).toContain('X-Doar-Folder: Pl%C3%A1n%20%26%20n%C3%A1vrhy\n')
    expect(text).toContain('X-Doar-Special-Use: \\Sent\n')
  })

  it('cudzí nástroj (Python mailbox) prečíta všetky správy aj prílohu', () => {
    let out: string
    try {
      out = execFileSync('python3', ['-I', '-c', `
import mailbox, sys, hashlib
box = mailbox.mbox(sys.argv[1])
msgs = list(box)
att = [p for m in msgs for p in m.walk() if p.get_filename() == 'zmluva.pdf']
print(len(msgs), len(att), hashlib.sha256(att[0].get_payload(decode=True)).hexdigest())
`, first.path]).toString().trim()
    } catch {
      return // python3 nie je k dispozícii
    }
    expect(out).toBe(`8 1 ${sha256(ATTACHMENT)}`)
  })

  it('s lokálnou kópiou (po synchronizácii) sa nič nesťahuje znova', async () => {
    ctx.sync.start(ctx.accountId)
    const end = Date.now() + 30_000
    while (Date.now() < end && !(ctx.sync.get(ctx.accountId)!.status.lastSync && ctx.store.countNeedingBodies(ctx.accountId) === 0)) await new Promise((r) => setTimeout(r, 200))
    expect(ctx.store.countNeedingBodies(ctx.accountId)).toBe(0)
    const second = await runExport(ctx, 'Doar-hana-2.mbox')
    await ctx.sync.stopAll()
    expect(second.summary.result).toBe('complete')
    expect(second.summary.downloaded).toBe(0)
    // Obsah je rovnaký ako pri prvej zálohe (rovnaké originály, rovnaké metadáta).
    const hashes = (p: string) => splitMboxrd(readFileSync(p)).map((e) => stripDoarBlock(e.message).block!.hash).sort()
    expect(hashes(second.path)).toEqual(hashes(first.path))
  })

  it('správa zmazaná na serveri počas zálohy → neúplná záloha s „-NEUPLNA“ v názve a presným súhrnom', async () => {
    const c = await makeCtx({
      afterSnapshot: async () => {
        const o = imap()
        await o.connect()
        const lock = await o.getMailboxLock('Plán & návrhy')
        try {
          await o.messageDelete('1:*')
        } finally {
          lock.release()
        }
        await o.logout()
      }
    })
    const r = await runExport(c, 'Doar-hana-zmazana.mbox')
    expect(r.summary.result).toBe('incomplete')
    expect(r.summary.path).toBe(join(outDir, 'Doar-hana-zmazana-NEUPLNA.mbox'))
    expect(existsSync(r.path)).toBe(false) // pod pôvodným menom (ako úplná záloha) nič nevzniklo
    expect(existsSync(r.summary.path!)).toBe(true)
    expect(r.summary.totals).toEqual({ expected: 8, exported: 7, unavailable: 1, failed: 0 })
    expect(r.summary.folders.find((f) => f.path === 'Plán & návrhy')).toMatchObject({ expected: 1, exported: 0, unavailable: 1 })
  })

  it('zrušenie → žiadny súbor, ani rozpracovaný', async () => {
    const c = await makeCtx({ afterSnapshot: async (ctx) => ctx.exports.cancel(ctx.exports.state().running!.jobId) })
    const before = new Set(readdirSync(outDir))
    const r = await runExport(c, 'Doar-hana-zrusena.mbox')
    expect(r.summary.result).toBe('cancelled')
    expect(r.summary.path).toBeNull()
    expect(readdirSync(outDir).filter((f) => !before.has(f))).toEqual([])
  })

  it('plný disk počas zápisu → zlyhanie DISK_FULL a rozpracovaný súbor sa zmaže', async () => {
    let writes = 0
    const fs: FsOps = {
      ...realFs,
      async open(p) {
        const h = await realFs.open(p)
        return {
          ...h,
          write: async (b: Buffer) => {
            if (++writes > 2) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
            return h.write(b)
          }
        }
      }
    }
    const before = new Set(readdirSync(outDir))
    const r = await runExport(await makeCtx({ fs }), 'Doar-hana-plny.mbox')
    expect(r.summary).toMatchObject({ result: 'failed', errorCode: 'DISK_FULL', path: null })
    expect(readdirSync(outDir).filter((f) => !before.has(f))).toEqual([])
  })

  it('nedostatok miesta zistený vopred → nič sa nesťahuje ani nezapisuje', async () => {
    const r = await runExport(await makeCtx({ fs: { ...realFs, freeSpace: async () => 1000 } }), 'Doar-hana-malo.mbox')
    expect(r.summary).toMatchObject({ result: 'failed', errorCode: 'DISK_FULL', downloaded: 0 })
    expect(existsSync(`${r.path}.part`)).toBe(false)
  })

  it('zapisovať sa dá len do súboru vybraného v dialógu', async () => {
    const c = await makeCtx()
    expect(() => c.exports.start(c.accountId, join(outDir, 'nepovolene.mbox'))).toThrow(/vybrať v dialógu/)
    c.exports.allow(join(outDir, 'zly-typ.exe'))
    expect(() => c.exports.start(c.accountId, join(outDir, 'zly-typ.exe'))).toThrow()
  })

  it('pád aplikácie počas zálohy → po spustení sa rozpracovaný súbor zmaže a úloha je zlyhaná', async () => {
    const c = await makeCtx()
    const part = join(outDir, 'Doar-hana-pad.mbox.part')
    writeFileSync(part, 'rozpracovane')
    c.db.prepare(`INSERT INTO jobs (kind, account_id, state, started_at, progress_json) VALUES ('export', ?, 'running', 'x', ?)`).run(c.accountId, JSON.stringify({ partPath: part }))
    new ExportManager({ db: c.db, store: c.store, blobs: new BlobStore(join(outDir, 'b')), emit: () => {}, newClient: (id) => c.sync.newImapClient(id) })
    expect(existsSync(part)).toBe(false)
    expect((c.db.prepare(`SELECT state FROM jobs WHERE kind = 'export'`).get() as { state: string }).state).toBe('failed')
  })
})
