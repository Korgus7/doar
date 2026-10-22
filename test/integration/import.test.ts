import { describe, it, expect, inject, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'
import { ExportManager } from '../../src/core/export/manager'
import { ImportManager } from '../../src/core/import/manager'
import { FileGrants } from '../../src/core/files'
import { canonicalize, sha256 } from '../../src/core/export/mboxrd'
import type { ImportMode, ImportSummary, ImportTarget } from '../../src/shared/ipc'

/**
 * Obnova zo zálohy: export pripravenej schránky → import do prázdneho konta → porovnanie po priečinkoch
 * (obsah bit po bite, dátumy, príznaky), opakovaný import, cudzí mbox, prerušenie, nejasné nahrávanie, plná schránka.
 */

const srv = inject('testserver')
const SOURCE = 'adam@doar.test'
const dir = mkdtempSync(join(tmpdir(), 'doar-import-'))

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

const ATTACHMENT = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256))

function plain(subject: string, body: string, extra = ''): Buffer {
  return Buffer.from(
    `Return-Path: <jan@firma.sk>\r\nFrom: Jan <jan@firma.sk>\r\nTo: ${SOURCE}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/[^a-z0-9]/gi, '')}.${Math.random().toString(36).slice(2)}@firma.sk>\r\nDate: Wed, 01 Oct 2026 09:00:00 +0000\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`,
    'utf8'
  )
}

const WITH_ATTACHMENT = Buffer.from(
  [
    'From: Eva <eva@firma.sk>',
    `To: ${SOURCE}`,
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

type Snap = Map<string, { hash: string; date: string; flags: string[] }[]>

/** Správy na serveri: priečinok → [{ kanonický hash, interný dátum, príznaky }] zoradené. */
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
      out.set(f.path, list.sort((a, b) => (a.hash + a.date).localeCompare(b.hash + b.date)))
    } finally {
      lock.release()
    }
  }
  await c.logout()
  return out
}

const count = (s: Snap): number => [...s.values()].reduce((n, l) => n + l.length, 0)

let db: Db
let store: MailStore
let files: FileGrants
let sync: SyncManager
let imports: ImportManager
let hook: ((seq: number) => Promise<void>) | undefined
const accounts = new Map<string, number>()
let backupPath = ''
let source: Snap
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

async function runImport(user: string, path: string, mode: ImportMode, target: ImportTarget = { newName: 'Import – test' }): Promise<ImportSummary> {
  files.allow(path, 'read')
  const { jobId } = await imports.start({ accountId: await account(user), path, mode, target })
  return (await imports.wait(jobId))!
}

async function resume(jobId: number): Promise<ImportSummary> {
  imports.resume(jobId)
  return (await imports.wait(jobId))!
}

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), 'doar-import-db-'))
  db = openDb(join(d, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(d, 'blobs'))
  const emit = () => {}
  files = new FileGrants()
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit })
  imports = new ImportManager({ db, store, blobs, emit, files, newClient: (id) => sync.newImapClient(id) }, { beforeAppend: (seq) => hook?.(seq) ?? Promise.resolve() })

  // Zdrojová schránka: príznaky, štítok, príloha, vnorený priečinok, diakritika,
  // tá istá správa v dvoch priečinkoch a dve rovnaké kópie v jednom priečinku.
  const c = imap(SOURCE)
  await c.connect()
  await c.mailboxCreate(['Faktúry', '2026'])
  await c.mailboxCreate('Plán & návrhy')
  const shared = plain('Zdieľaná', 'Je v dvoch priečinkoch\r\n')
  const twin = plain('Dvojča', 'Dve rovnaké kópie\r\n')
  await c.append('INBOX', plain('Prvá – s hviezdičkou', 'Ahoj,\r\nFrom the beginning\r\n>From x\r\nKoniec\r\n'), ['\\Seen', '\\Flagged'], new Date('2026-09-01T08:00:00Z'))
  await c.append('INBOX', WITH_ATTACHMENT, [], new Date('2026-09-02T09:30:00Z'))
  await c.append('INBOX', plain('Odpovedaná', 'Text\r\n'), ['\\Seen', '\\Answered', '$Forwarded'], new Date('2026-09-03T10:00:00Z'))
  await c.append('INBOX', plain('Bez konca riadku', 'posledny riadok bez CRLF'), [], new Date('2026-09-04T11:00:00Z'))
  await c.append('INBOX', shared, ['\\Seen'], new Date('2026-09-05T11:30:00Z'))
  await c.append('Sent', plain('Odoslaná', 'x\r\n'), ['\\Seen'], new Date('2026-09-05T12:00:00Z'))
  await c.append('Faktúry/2026', plain('Faktúra 001', 'Suma 120 €\r\n'), ['\\Seen'], new Date('2026-09-06T13:00:00Z'))
  await c.append('Faktúry/2026', twin, [], new Date('2026-09-07T14:00:00Z'))
  await c.append('Faktúry/2026', twin, [], new Date('2026-09-07T14:00:00Z'))
  await c.append('Plán & návrhy', shared, ['\\Seen'], new Date('2026-09-05T11:30:00Z'))
  await c.append('Trash', plain('Zmazaná', 'preč\r\n'), ['\\Seen', '\\Deleted'], new Date('2026-09-08T15:00:00Z'))
  await c.append('INBOX', Buffer.from('From: Linux <lf@firma.sk>\nSubject: Holé LF\nMessage-ID: <holelf@firma.sk>\n\nriadok 1\nriadok 2\rstarý Mac\n', 'utf8'), [], new Date('2026-09-09T10:00:00Z'))
  await c.logout()
  source = await readServer(SOURCE)

  // Záloha cez Doar (rovnaký kód ako v aplikácii).
  const exports = new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) })
  backupPath = join(dir, 'Doar-adam.mbox')
  exports.allow(backupPath)
  const { jobId } = exports.start(await account(SOURCE), backupPath)
  const s = (await exports.wait(jobId))!
  expect(s.result).toBe('complete')
  expect(s.totals.exported).toBe(12)
})

describe('obnova zo zálohy do konta', () => {
  it('náhľad súboru: záloha Doar a jej pôvodné konto', async () => {
    files.allow(backupPath, 'read')
    const p = await imports.peek(backupPath)
    expect(p).toMatchObject({ name: 'Doar-adam.mbox', doar: true, source: SOURCE })
    expect(p.sizeBytes).toBeGreaterThan(5000)
  })

  it('do pôvodných priečinkov v prázdnom konte: počty, obsah bit po bite, dátumy a príznaky sedia', async () => {
    const s = await runImport('beata@doar.test', backupPath, 'restore')
    expect(s.result).toBe('complete')
    expect(s.totals).toEqual({ total: 12, uploaded: 12, duplicate: 0, failed: 0, pending: 0 })
    expect(s.changedOutside).toBe(0)
    expect(s.foreign).toBe(0)
    expect(s.keywordsDropped).toBe(0)
    const target = await readServer('beata@doar.test')
    for (const [path, msgs] of source) {
      // \Deleted sa zálohuje aj obnovuje len ako bežná správa (príznak \Deleted sa do zálohy nedáva).
      const expected = msgs.map((m) => ({ ...m, flags: m.flags.filter((f) => f !== '\\Deleted') }))
      expect(target.get(path), path).toEqual(expected)
    }
    expect(count(target)).toBe(12)
    expect(target.has('Import – test')).toBe(false) // záložný priečinok netreba – všetky správy majú metadáta
    const byPath = Object.fromEntries(s.folders.map((f) => [f.path, f.uploaded]))
    expect(byPath).toMatchObject({ INBOX: 6, Sent: 1, 'Faktúry / 2026': 3, 'Plán & návrhy': 1, Trash: 1 })
  })

  it('obnova do pôvodného konta (originály na serveri, nie kópie z Doaru) nič nezdvojí', async () => {
    const before = await readServer(SOURCE)
    const s = await runImport(SOURCE, backupPath, 'restore')
    expect(s.result).toBe('complete')
    expect(s.totals).toEqual({ total: 12, uploaded: 0, duplicate: 12, failed: 0, pending: 0 })
    expect(await readServer(SOURCE)).toEqual(before)
  })

  it('opakovaná obnova toho istého súboru nič nezdvojí (ani dve rovnaké kópie, ani správu v dvoch priečinkoch)', async () => {
    const before = await readServer('beata@doar.test')
    const s = await runImport('beata@doar.test', backupPath, 'restore')
    expect(s.result).toBe('complete')
    expect(s.totals).toEqual({ total: 12, uploaded: 0, duplicate: 12, failed: 0, pending: 0 })
    expect(await readServer('beata@doar.test')).toEqual(before)
  })

  it('chýbajúca správa sa pri opakovanej obnove doplní – len tá jedna', async () => {
    // Používateľ zmazal jednu z dvoch rovnakých kópií → obnova vráti práve jednu.
    const c = imap('beata@doar.test')
    await c.connect()
    const lock = await c.getMailboxLock('Faktúry/2026')
    try {
      const uids = (await c.search({ subject: 'Dvojča' }, { uid: true })) || []
      expect(uids).toHaveLength(2)
      await c.messageDelete(String(uids[0]), { uid: true })
    } finally {
      lock.release()
    }
    await c.logout()
    const s = await runImport('beata@doar.test', backupPath, 'restore')
    expect(s.totals).toMatchObject({ uploaded: 1, duplicate: 11 })
    expect((await readServer('beata@doar.test')).get('Faktúry/2026')).toEqual(source.get('Faktúry/2026'))
  })

  it('všetko do jedného nového priečinka; existujúca pošta zostane', async () => {
    const before = await readServer('beata@doar.test')
    const s = await runImport('beata@doar.test', backupPath, 'single', { newName: 'Import – Adam' })
    expect(s.totals).toMatchObject({ total: 12, uploaded: 12 })
    const after = await readServer('beata@doar.test')
    expect(after.get('Import – Adam')).toHaveLength(12)
    for (const [path, msgs] of before) expect(after.get(path), path).toEqual(msgs)
  })

  it('cudzí mbox: do zvoleného priečinka, príznaky zo Status/X-Status, dátum z oddeľovača, pôvodný obsah', async () => {
    const path = join(dir, 'thunderbird.mbox')
    writeFileSync(
      path,
      [
        'From - Wed Oct  1 14:36:00 2026',
        'From: Jan <jan@firma.sk>',
        'Subject: Cudzia 1',
        'Message-ID: <cudzia1@firma.sk>',
        'Status: RO',
        'X-Status: F',
        '',
        'Ahoj,',
        '',
        'From my point of view hotovo.',
        '',
        'From - Thu Oct  2 08:00:00 2026',
        'From: Eva <eva@firma.sk>',
        'Subject: Cudzia 2 bez Message-ID',
        'Date: Thu, 02 Oct 2026 08:00:00 +0000',
        '',
        'Text',
        ''
      ].join('\n')
    )
    files.allow(path, 'read')
    expect(await imports.peek(path)).toMatchObject({ doar: false, source: null })
    const s = await runImport('cyril@doar.test', path, 'restore', { newName: 'Thunderbird' })
    expect(s.result).toBe('complete')
    expect(s.foreign).toBe(2)
    const got = (await readServer('cyril@doar.test')).get('Thunderbird')!
    expect(got).toHaveLength(2)
    const one = got.find((m) => m.date === '2026-10-01T14:36:00.000Z')!
    expect(one.flags).toEqual(['\\Flagged', '\\Seen'])
    expect(got.find((m) => m.date === '2026-10-02T08:00:00.000Z')!.flags).toEqual([])
    // Opakovane (aj správa bez Message-ID) – nič nové.
    const again = await runImport('cyril@doar.test', path, 'single', { newName: 'Thunderbird' })
    expect(again.totals).toMatchObject({ uploaded: 0, duplicate: 2 })
  })

  it('zrušenie uprostred a pokračovanie: dokončí sa, nič sa nezdvojí', async () => {
    const ctl = { n: 0 }
    hook = async () => {
      if (++ctl.n === 4) imports.cancel(imports.state().running!.jobId)
    }
    const s = await runImport('dusan@doar.test', backupPath, 'restore')
    hook = undefined
    expect(s.result).toBe('cancelled')
    expect(s.resumable).toBe(true)
    expect(s.totals.uploaded).toBe(3)
    expect(imports.state().resumable.map((j) => j.jobId)).toContain(s.jobId)
    const done = await resume(s.jobId)
    expect(done.result).toBe('complete')
    expect(done.totals).toEqual({ total: 12, uploaded: 12, duplicate: 0, failed: 0, pending: 0 })
    expect(count(await readServer('dusan@doar.test'))).toBe(12)
    expect(imports.state().resumable.map((j) => j.jobId)).not.toContain(s.jobId)
  })

  it('výpadok spojenia počas nahrávania: správa, ktorá na server došla, sa nenahrá znova; tá, ktorá nedošla, áno', async () => {
    let fail: 'after' | 'before' | null = null
    const flaky = new ImportManager(
      {
        db, store, blobs: new BlobStore(join(dir, 'blobs3')), emit: () => {}, files,
        newClient: async (id) => {
          const c = await sync.newImapClient(id)
          const orig = c.append.bind(c)
          c.append = (async (...args: Parameters<typeof orig>) => {
            const mode = fail
            fail = null
            if (mode === 'before') {
              c.close()
              throw Object.assign(new Error('spojenie spadlo'), { code: 'ECONNRESET' })
            }
            const r = await orig(...args)
            if (mode === 'after') {
              c.close() // server správu uložil, ale odpoveď sa stratila
              throw Object.assign(new Error('spojenie spadlo'), { code: 'ECONNRESET' })
            }
            return r
          }) as typeof c.append
          return c
        }
      },
      {
        beforeAppend: async (seq) => {
          if (seq === 2) fail = 'after' // správa s prílohou – bez Message-ID, porovná sa celý obsah
          if (seq === 4) fail = 'before'
        }
      }
    )
    files.allow(backupPath, 'read')
    const { jobId } = await flaky.start({ accountId: await account('cyril@doar.test'), path: backupPath, mode: 'single', target: { newName: 'Výpadok' } })
    const s = (await flaky.wait(jobId))!
    expect(s.result).toBe('complete')
    expect(s.totals).toEqual({ total: 12, uploaded: 12, duplicate: 0, failed: 0, pending: 0 })
    const got = (await readServer('cyril@doar.test')).get('Výpadok')!
    expect(got).toHaveLength(12)
    expect(got.map((m) => m.hash).sort()).toEqual([...source.values()].flat().map((m) => m.hash).sort())
  })

  it('nejasné nahrávanie (pád počas APPEND): pred opakovaním sa overí, či správa na serveri je', async () => {
    const jobId = (db.prepare(`SELECT MAX(id) AS id FROM jobs WHERE kind = 'import' AND account_id = ?`).get(await account('dusan@doar.test')) as { id: number }).id
    // Simulácia pádu: dve správy „rozpracované“ – jedna na serveri je, druhú server nedostal (zmažeme ju).
    const rows = db.prepare(`SELECT seq, target_folder, appended_uid FROM import_items WHERE job_id = ? AND target_folder = 'INBOX' ORDER BY seq`).all(jobId) as { seq: number; target_folder: string; appended_uid: number }[]
    const [landed, lost] = rows
    const c = imap('dusan@doar.test')
    await c.connect()
    const lock = await c.getMailboxLock('INBOX')
    try {
      await c.messageDelete(String(lost!.appended_uid), { uid: true })
    } finally {
      lock.release()
    }
    await c.logout()
    db.prepare(`UPDATE import_items SET state = 'appending', appended_uid = NULL WHERE job_id = ? AND seq IN (?, ?)`).run(jobId, landed!.seq, lost!.seq)
    db.prepare(`UPDATE jobs SET state = 'running', summary_json = NULL WHERE id = ?`).run(jobId)
    // Nový štart aplikácie: rozpracovaná obnova sa ponúkne na pokračovanie.
    imports = new ImportManager(
      { db, store, blobs: new BlobStore(join(dir, 'blobs2')), emit: () => {}, files, newClient: (id) => sync.newImapClient(id) },
      { beforeAppend: (seq) => hook?.(seq) ?? Promise.resolve() }
    )
    expect(imports.state().resumable.find((j) => j.jobId === jobId)?.errorCode).toBe('APP_CLOSED')
    const s = await resume(jobId)
    expect(s.result).toBe('complete')
    expect(s.totals).toEqual({ total: 12, uploaded: 12, duplicate: 0, failed: 0, pending: 0 })
    const snap = await readServer('dusan@doar.test')
    expect(count(snap)).toBe(12) // stratená sa nahrala znova, tá na serveri nie
    expect(snap.get('INBOX')).toEqual(source.get('INBOX'))
  })

  it('plná schránka: zastaví sa so súhrnom; po uvoľnení miesta pokračuje len zvyšok', async () => {
    const parts: Buffer[] = []
    const path = join(dir, 'velka.mbox')
    for (let i = 0; i < 8; i++) {
      parts.push(Buffer.from(`From - Wed Oct  1 1${i}:00:00 2026\nFrom: x@firma.sk\nSubject: Veľká ${i}\nMessage-ID: <velka${i}@firma.sk>\n\n${'y'.repeat(70)}\n`.repeat(1) + `${'z'.repeat(76)}\n`.repeat(36) + '\n', 'latin1'))
    }
    writeFileSync(path, Buffer.concat(parts))
    const first = await runImport('mala@doar.test', path, 'single', { newName: 'Import' })
    expect(first.result).toBe('stopped')
    expect(first.errorCode).toBe('OVERQUOTA')
    expect(first.resumable).toBe(true)
    expect(first.totals.uploaded).toBeGreaterThan(0)
    expect(first.totals.pending).toBe(8 - first.totals.uploaded)
    // Uvoľnenie miesta: používateľ zmaže, čo už je nahrané. Nahrané správy sa pri pokračovaní znova nenahrajú.
    let uploaded = first.totals.uploaded
    let s = first
    for (let round = 0; round < 8 && s.result !== 'complete'; round++) {
      const c = imap('mala@doar.test')
      await c.connect()
      const lock = await c.getMailboxLock('Import')
      try {
        await c.messageDelete('1:*')
      } finally {
        lock.release()
      }
      await c.logout()
      s = await resume(s.jobId)
      expect(s.totals.uploaded).toBeGreaterThan(uploaded)
      uploaded = s.totals.uploaded
    }
    expect(s.result).toBe('complete')
    expect(s.totals).toMatchObject({ total: 8, uploaded: 8, failed: 0, pending: 0 })
  })

  it('súbor zmenený medzi prerušením a pokračovaním → nepokračuje (nič by nesedelo)', async () => {
    const path = join(dir, 'menena.mbox')
    writeFileSync(path, readFileSync(backupPath))
    hook = async (seq) => {
      if (seq === 2) imports.cancel((imports.state().running ?? { jobId: 0 }).jobId)
    }
    const s = await runImport('dusan@doar.test', path, 'single', { newName: 'Menená' })
    hook = undefined
    expect(s.result).toBe('cancelled')
    appendFileSync(path, 'From - Wed Oct  1 14:36:00 2026\nSubject: nová\n\nx\n')
    const r = await resume(s.jobId)
    expect(r.result).toBe('failed')
    expect(r.errorCode).toBe('FILE_CHANGED')
  })

  it('súbor, ktorý nie je mbox; súbor nevybraný v dialógu', async () => {
    const path = join(dir, 'nie.mbox')
    writeFileSync(path, 'Subject: ahoj\r\n\r\ntext\r\n')
    files.allow(path, 'read')
    await expect(imports.peek(path)).rejects.toMatchObject({ code: 'NOT_MBOX' })
    const s = await runImport('dusan@doar.test', path, 'single')
    expect(s.result).toBe('failed')
    expect(s.errorCode).toBe('NOT_MBOX')
    await expect(imports.start({ accountId: await account('dusan@doar.test'), path: join(dir, 'iny.mbox'), mode: 'single', target: { newName: 'x' } })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
  })
})
