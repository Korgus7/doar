import { describe, it, expect, inject, beforeAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'
import { ImportManager } from '../../src/core/import/manager'
import { FileGrants } from '../../src/core/files'
import { canonicalize, sha256 } from '../../src/core/export/mboxrd'
import { dbxFolders, dbxMessages } from '../fixtures/dbx-writer'
import type { ImportMode, ImportSummary } from '../../src/shared/ipc'

/**
 * Import z iných programov do konta na testovacom serveri: Outlook Express (.dbx), Windows Mail (.eml)
 * a Outlook (.pst) – štandardné priečinky podľa funkcie, podpriečinky, príznaky, dátumy, opakovanie bez duplicít,
 * zrušenie a pokračovanie, upratanie dočasného súboru.
 */

const srv = inject('testserver')
const ENRON = join(import.meta.dirname, '../../node_modules/pst-extractor/example/testdata/enron.pst')

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

const mail = (subject: string, date = 'Wed, 01 Oct 2003 09:00:00 +0000'): Buffer =>
  Buffer.from(`From: Ján <jan@firma.sk>\r\nTo: nina@doar.test\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: <${subject.replace(/\W/g, '')}.oe@firma.sk>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nText správy ${subject}.\r\n`, 'utf8')

type Snap = Map<string, { hash: string; date: string; flags: string[] }[]>

async function readServer(user: string): Promise<Snap> {
  const out: Snap = new Map()
  const c = imap(user)
  await c.connect()
  for (const f of await c.list()) {
    if (f.flags.has('\\Noselect') || f.flags.has('\\NonExistent')) continue
    const lock = await c.getMailboxLock(f.path, { readOnly: true })
    try {
      const list: { hash: string; date: string; flags: string[] }[] = []
      if (c.mailbox && c.mailbox.exists) {
        for await (const m of c.fetch('1:*', { source: true, internalDate: true, flags: true })) {
          list.push({ hash: sha256(canonicalize(m.source!)), date: new Date(m.internalDate!).toISOString(), flags: [...(m.flags ?? [])].filter((x) => x !== '\\Recent').sort() })
        }
      }
      if (list.length) out.set(f.path, list)
    } finally {
      lock.release()
    }
  }
  await c.logout()
  return out
}

let db: Db
let files: FileGrants
let sync: SyncManager
let imports: ImportManager
let workDir: string
let hook: ((seq: number) => Promise<void>) | undefined
const accounts = new Map<string, number>()
const secrets = new MemorySecrets(true)

async function account(user: string): Promise<number> {
  if (accounts.has(user)) return accounts.get(user)!
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: user, displayName: user, username: user,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: true, providerKey: null
    },
    password: srv.password,
    rememberPassword: true
  })
  accounts.set(user, acc.id)
  return acc.id
}

async function runImport(user: string, path: string, mode: ImportMode = 'restore', grant: 'read' | 'tree' = 'tree'): Promise<ImportSummary> {
  files.allow(path, grant)
  const { jobId } = await imports.start({ accountId: await account(user), path, mode, target: { newName: 'Import – test' } })
  return (await imports.wait(jobId))!
}

let oeDir = ''

beforeAll(() => {
  const d = mkdtempSync(join(tmpdir(), 'doar-import-src-db-'))
  db = openDb(join(d, 'doar.db'))
  const store = new MailStore(db)
  const blobs = new BlobStore(join(d, 'blobs'))
  const emit = () => {}
  files = new FileGrants()
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit })
  workDir = join(d, 'import-work')
  imports = new ImportManager({ db, store, blobs, emit, files, workDir, newClient: (id) => sync.newImapClient(id) }, { beforeAppend: (seq) => hook?.(seq) ?? Promise.resolve() })

  // Outlook Express 6 (slovenská verzia): Miestne priečinky → Doručená pošta (+ podpriečinok Projekty), Odoslaná pošta, Odstránená pošta.
  oeDir = mkdtempSync(join(tmpdir(), 'doar-oe-'))
  writeFileSync(
    join(oeDir, 'Folders.dbx'),
    dbxFolders([
      { id: 0, parent: 0, name: 'Outlook Express' },
      { id: 1, parent: 0, name: 'Miestne priečinky' },
      { id: 2, parent: 1, name: 'Doručená pošta', file: 'Doručená pošta.dbx' },
      { id: 3, parent: 2, name: 'Projekty', file: 'Projekty.dbx' },
      { id: 4, parent: 1, name: 'Odoslaná pošta', file: 'Odoslaná pošta.dbx' },
      { id: 5, parent: 1, name: 'Odstránená pošta', file: 'Odstránená pošta.dbx' }
    ])
  )
  writeFileSync(
    join(oeDir, 'Doručená pošta.dbx'),
    dbxMessages([
      { raw: mail('Prva'), flags: 0x80, received: new Date('2003-10-01T10:00:00Z') },
      { raw: mail('Druha neprecitana'), flags: 0, received: new Date('2003-10-02T10:00:00Z') },
      { raw: mail('Tretia odpovedana'), flags: 0x80 | 0x80000, received: new Date('2003-10-03T10:00:00Z') }
    ])
  )
  writeFileSync(join(oeDir, 'Projekty.dbx'), dbxMessages(Array.from({ length: 12 }, (_, i) => ({ raw: mail(`Projekt ${i + 1}`), flags: 0x80, received: new Date(Date.UTC(2003, 10, i + 1)) }))))
  writeFileSync(join(oeDir, 'Odoslaná pošta.dbx'), dbxMessages([{ raw: mail('Odoslana'), flags: 0x80, received: new Date('2003-10-05T10:00:00Z') }]))
  writeFileSync(join(oeDir, 'Odstránená pošta.dbx'), dbxMessages([{ raw: mail('Zmazana'), flags: 0x80, received: new Date('2003-10-06T10:00:00Z') }]))
})

describe('import z Outlook Expressu', () => {
  it('náhľad priečinka: formát, počet priečinkov a správ', async () => {
    files.allow(oeDir, 'tree')
    expect(await imports.peek(oeDir)).toMatchObject({ format: 'dbx', messages: 17, folders: 4, doar: false, sizeBytes: 0 })
  })

  it('do pôvodných priečinkov: štandardné podľa funkcie, podpriečinok, obsah bit po bite, príznaky a dátumy', async () => {
    const s = await runImport('nina@doar.test', oeDir)
    expect(s.result).toBe('complete')
    expect(s.fileName).toBe(oeDir.split(/[\\/]/).pop())
    expect(s.totals).toEqual({ total: 17, uploaded: 17, duplicate: 0, failed: 0, pending: 0 })
    const server = await readServer('nina@doar.test')
    expect([...server.keys()].sort()).toEqual(['INBOX', 'INBOX/Projekty', 'Sent', 'Trash'])
    const inbox = server.get('INBOX')!
    expect(inbox.map((m) => m.hash).sort()).toEqual([mail('Prva'), mail('Druha neprecitana'), mail('Tretia odpovedana')].map((b) => sha256(canonicalize(b))).sort())
    const byDate = Object.fromEntries(inbox.map((m) => [m.date, m.flags]))
    expect(byDate).toEqual({
      '2003-10-01T10:00:00.000Z': ['\\Seen'],
      '2003-10-02T10:00:00.000Z': [],
      '2003-10-03T10:00:00.000Z': ['\\Answered', '\\Seen']
    })
    expect(server.get('INBOX/Projekty')).toHaveLength(12)
    expect(server.get('Sent')).toHaveLength(1)
    expect(server.get('Trash')).toHaveLength(1)
    // Dočasný súbor prevodu po dokončení zmizne.
    expect(readdirSync(workDir)).toEqual([])
  })

  it('opakovaný import nič nezdvojí', async () => {
    const s = await runImport('nina@doar.test', oeDir)
    expect(s.totals).toEqual({ total: 17, uploaded: 0, duplicate: 17, failed: 0, pending: 0 })
  })

  it('zrušenie uprostred a pokračovanie (dočasný súbor ostane, kým sa obnova nedokončí)', async () => {
    let n = 0
    hook = async () => {
      if (++n === 6) for (const j of imports.state().running ? [imports.state().running!.jobId] : []) imports.cancel(j)
    }
    const s = await runImport('sona@doar.test', oeDir)
    hook = undefined
    expect(s.result).toBe('cancelled')
    expect(s.resumable).toBe(true)
    expect(readdirSync(workDir)).toEqual([`import-${s.jobId}.mbox`])
    imports.resume(s.jobId)
    const r = (await imports.wait(s.jobId))!
    expect(r.result).toBe('complete')
    expect(r.totals.uploaded + r.totals.duplicate).toBe(17)
    expect(r.totals.uploaded).toBe(17)
    expect(readdirSync(workDir)).toEqual([])
    const server = await readServer('sona@doar.test')
    expect([...server.values()].reduce((a, l) => a + l.length, 0)).toBe(17)
  })

  it('všetko do jedného priečinka', async () => {
    const s = await runImport('quido@doar.test', oeDir, 'single')
    expect(s.totals.uploaded).toBe(17)
    const server = await readServer('quido@doar.test')
    expect([...server.keys()]).toEqual(['Import – test'])
  })
})

describe('import z Outlooku (.pst)', () => {
  it('priečinky zo súboru, všetky správy, opakovanie bez duplicít', async () => {
    files.allow(ENRON, 'read')
    expect(await imports.peek(ENRON)).toMatchObject({ format: 'pst', messages: 71, folders: 5 })
    const s = await runImport('rita@doar.test', ENRON, 'restore', 'read')
    expect(s.result).toBe('complete')
    expect(s.totals).toMatchObject({ total: 71, uploaded: 71, failed: 0 })
    const server = await readServer('rita@doar.test')
    expect(server.get('lokay-m/MLOKAY (Non-Privileged)/Personal')).toHaveLength(47)
    expect(server.get('lokay-m/MLOKAY (Non-Privileged)/Sent Items')).toHaveLength(2)
    const again = await runImport('rita@doar.test', ENRON, 'restore', 'read')
    expect(again.totals).toMatchObject({ uploaded: 0, duplicate: 71 })
  }, 120_000)
})

describe('import z Windows Mail (.eml)', () => {
  it('podpriečinky podľa disku, správy ako prečítané', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doar-wlm-'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'Inbox', 'Rodina'), { recursive: true })
    writeFileSync(join(dir, 'Inbox', 'a.eml'), mail('WLM prva'))
    writeFileSync(join(dir, 'Inbox', 'Rodina', 'b.eml'), mail('WLM rodina'))
    const s = await runImport('viera@doar.test', dir)
    expect(s.totals.uploaded).toBe(2)
    const server = await readServer('viera@doar.test')
    expect(server.get('INBOX')![0]!.flags).toEqual(['\\Seen'])
    expect(server.get('INBOX/Rodina')).toHaveLength(1)
    expect(existsSync(join(workDir, `import-${s.jobId}.mbox`))).toBe(false)
  })

  it('priečinok bez pošty sa odmietne už pri náhľade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doar-empty-'))
    files.allow(dir, 'tree')
    await expect(imports.peek(dir)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})
