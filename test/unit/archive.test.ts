import { describe, it, expect, beforeAll } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { FileGrants } from '../../src/core/files'
import { ArchiveManager } from '../../src/core/archive/archive'
import { encodeMessage, type MessageMeta } from '../../src/core/export/mboxrd'
import { messageRaw } from '../../src/core/attachments'
import { prepareCompose } from '../../src/core/compose-service'
import { extractAttachments } from '../../src/core/mail/parse'
import { buildFtsQuery } from '../../src/core/search'
import type { SyncManager } from '../../src/core/sync/manager'

/**
 * Lokálny archív: súbor mbox len na čítanie – priečinky, zoznam, čítanie, vyhľadávanie, prílohy,
 * odpoveď, zmenený a chýbajúci súbor, zatvorenie. Pôvodný súbor sa nikdy nemení.
 */

const dir = mkdtempSync(join(tmpdir(), 'doar-archive-'))
const ATT = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 13) % 256))

const plain = (subject: string, body: string, id: string): Buffer =>
  Buffer.from(`From: Ján Novák <jan@firma.sk>\r\nTo: Eva <eva@firma.sk>\r\nSubject: ${subject}\r\nMessage-ID: <${id}@firma.sk>\r\nDate: Wed, 01 Oct 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`, 'utf8')

const withAttachment = Buffer.from(
  [
    'From: Eva <eva@firma.sk>',
    'To: jan@firma.sk',
    'Subject: =?UTF-8?Q?Zmluva_=E2=80=93_pr=C3=ADloha?=',
    'Message-ID: <zmluva@firma.sk>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'V prílohe posielam podpísanú zmluvu.',
    '--b1',
    'Content-Type: application/pdf; name="zmluva.pdf"',
    'Content-Disposition: attachment; filename="zmluva.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    ...(ATT.toString('base64').match(/.{1,76}/g) ?? []),
    '--b1--',
    ''
  ].join('\r\n')
)

const meta = (folderSegments: string[], specialUse: MessageMeta['specialUse'], flags: string[], date: string): MessageMeta => ({
  source: 'jan@firma.sk',
  folderSegments,
  specialUse,
  internalDate: new Date(date),
  flags: new Set(flags)
})

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

let db: Db
let files: FileGrants
let archives: ArchiveManager
const events: string[] = []
let path: string
let archiveId: number

function ctx(): Parameters<typeof prepareCompose>[0] {
  return { db, blobs: new BlobStore(join(dir, 'blobs')), store: new MailStore(db), sync: {} as SyncManager, emit: () => {}, archives }
}

beforeAll(() => {
  db = openDb(join(dir, 'doar.db'))
  db.prepare(`INSERT INTO accounts(email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username)
    VALUES ('ina@firma.sk','imap.firma.sk',993,'tls','smtp.firma.sk',465,'tls','ina@firma.sk'),
           ('jan@firma.sk','imap.firma.sk',993,'tls','smtp.firma.sk',465,'tls','jan@firma.sk')`).run()
  files = new FileGrants()
  archives = new ArchiveManager({ db, files, emit: (ch) => void events.push(ch) })
  path = join(dir, 'Doar-jan.mbox')
  writeFileSync(
    path,
    Buffer.concat([
      encodeMessage(plain('Prvá', 'Faktúra za september je v prílohe.\r\n', 'a1'), meta(['INBOX'], '\\Inbox', ['\\Seen', '\\Flagged'], '2026-09-01T08:00:00Z')).chunk,
      encodeMessage(withAttachment, meta(['INBOX'], '\\Inbox', [], '2026-09-03T08:00:00Z')).chunk,
      encodeMessage(plain('Odoslaná', 'Ďakujem.\r\n', 'a2'), meta(['Sent'], '\\Sent', ['\\Seen'], '2026-09-02T08:00:00Z')).chunk,
      encodeMessage(plain('Faktúra 001', 'Suma 120 €\r\n', 'a3'), meta(['Faktúry', '2026'], null, [], '2026-09-04T08:00:00Z')).chunk
    ])
  )
})

describe('lokálny archív', () => {
  it('otvorí len súbor vybraný v dialógu', async () => {
    await expect(archives.open(path)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
  })

  it('načítanie: priečinky podľa metadát Doar, počty, neprečítané; súbor sa nezmení', async () => {
    const before = sha(path)
    files.allow(path, 'read')
    archiveId = (await archives.open(path)).archiveId
    await archives.wait(archiveId)
    const { archives: list, folders } = archives.list()
    expect(list).toMatchObject([{ id: archiveId, name: 'Doar-jan.mbox', state: 'ready', messageCount: 4, doar: true, source: 'jan@firma.sk' }])
    expect(folders.map((f) => [f.name, f.specialUse, f.total, f.unread])).toEqual([
      ['INBOX', 'inbox', 2, 1],
      ['Sent', 'sent', 1, 0],
      ['Faktúry / 2026', null, 1, 1]
    ])
    expect(folders.every((f) => f.id < 0 && f.accountId === -archiveId)).toBe(true)
    expect(sha(path)).toBe(before)
    expect(events).toContain('archives.changed')
    // Opätovné otvorenie toho istého súboru nevytvorí druhý archív.
    expect((await archives.open(path)).archiveId).toBe(archiveId)
    expect(archives.list().archives).toHaveLength(1)
  })

  it('zoznam správ priečinka od najnovších, dekódovaný predmet, príznaky', () => {
    const inbox = archives.list().folders[0]!
    const r = archives.listMessages(inbox.id, 0, 50)
    expect(r.total).toBe(2)
    expect(r.items.map((m) => m.subject)).toEqual(['Zmluva – príloha', 'Prvá'])
    expect(r.items[0]).toMatchObject({ seen: false, hasAttachments: true, fromAddr: 'eva@firma.sk', folderId: inbox.id, accountName: 'Doar-jan.mbox' })
    expect(r.items[1]).toMatchObject({ seen: true, flagged: true, fromName: 'Ján Novák', snippet: 'Faktúra za september je v prílohe.' })
    expect(r.items.every((m) => m.id < 0)).toBe(true)
    expect(archives.listIds(inbox.id)).toEqual(r.items.map((m) => m.id))
  })

  it('vyhľadávanie bez diakritiky – v priečinku aj v celom archíve', () => {
    const inbox = archives.list().folders[0]!
    const q = buildFtsQuery('faktura')!
    expect(archives.search(q, { archiveId }, 0, 50).items.map((m) => m.subject).sort()).toEqual(['Faktúra 001', 'Prvá'])
    expect(archives.search(q, { folderId: inbox.id }, 0, 50).items.map((m) => m.subject)).toEqual(['Prvá'])
    expect(archives.searchIds(buildFtsQuery('podpisanu zmluvu')!, { archiveId })).toHaveLength(1)
    expect(archives.search(buildFtsQuery('od:eva')!, { archiveId }, 0, 50).total).toBe(1)
  })

  it('čítanie správy a príloha zo súboru (bit po bite)', async () => {
    const inbox = archives.list().folders[0]!
    const id = archives.listMessages(inbox.id, 0, 50).items[0]!.id
    const view = await archives.view(id, {})
    expect(view).toMatchObject({ id, subject: 'Zmluva – príloha', accountId: -archiveId })
    expect(view.text).toContain('podpísanú zmluvu')
    expect(view.attachments.map((a) => a.filename)).toEqual(['zmluva.pdf'])
    const att = await extractAttachments(await messageRaw({ ...ctx(), archives }, id))
    expect(att[0]!.content.equals(ATT)).toBe(true)
  })

  it('odpoveď na správu z archívu: z konta, z ktorého záloha pochádza, s citáciou', async () => {
    const id = archives.listMessages(archives.list().folders[0]!.id, 0, 50).items[1]!.id
    const p = await prepareCompose(ctx(), 'reply', id)
    const jan = (db.prepare(`SELECT id FROM accounts WHERE email = 'jan@firma.sk'`).get() as { id: number }).id
    expect(p.accountId).toBe(jan)
    expect(p.subject).toBe('Re: Prvá')
    expect(p.quote?.text).toContain('Faktúra za september')
  })

  it('cudzí mbox: všetky správy v jednom priečinku', async () => {
    const p = join(dir, 'thunderbird.mbox')
    writeFileSync(p, 'From - Wed Oct  1 14:36:00 2026\nFrom: a@b.sk\nSubject: Cudzia\nStatus: RO\n\nText\n\nFrom - Thu Oct  2 08:00:00 2026\nFrom: c@d.sk\nSubject: Druhá\n\nText 2\n')
    files.allow(p, 'read')
    const { archiveId: id } = await archives.open(p)
    await archives.wait(id)
    const f = archives.list().folders.filter((x) => x.accountId === -id)
    expect(f.map((x) => [x.name, x.total, x.unread])).toEqual([['', 2, 1]])
    await archives.close(id)
  })

  it('zmenený súbor: správa sa neotvorí so zlým obsahom, archív sa načíta znova', async () => {
    appendFileSync(path, encodeMessage(plain('Nová v súbore', 'x\r\n', 'a4'), meta(['INBOX'], '\\Inbox', [], '2026-09-05T08:00:00Z')).chunk)
    // Zmena dĺžky na začiatku súboru: posunuté pozície → odtlačok nesedí.
    const data = readFileSync(path)
    writeFileSync(path, Buffer.concat([Buffer.from(encodeMessage(plain('Úplne prvá', 'y\r\n', 'a0'), meta(['INBOX'], '\\Inbox', [], '2026-08-01T08:00:00Z')).chunk), data]))
    const id = archives.listMessages(archives.list().folders[0]!.id, 0, 50).items[0]!.id
    await expect(archives.view(id, {})).rejects.toMatchObject({ code: 'ARCHIVE_CHANGED' })
    await new Promise((r) => setTimeout(r, 50))
    await archives.wait(archiveId)
    expect(archives.list().archives[0]).toMatchObject({ state: 'ready', messageCount: 6 })
  })

  it('chýbajúci súbor (odpojený disk): archív zostane, po vrátení súboru funguje', async () => {
    const id = archives.listMessages(archives.list().folders[0]!.id, 0, 50).items[0]!.id
    renameSync(path, `${path}.preč`)
    await expect(archives.view(id, {})).rejects.toMatchObject({ code: 'ARCHIVE_FILE_MISSING' })
    expect(archives.list().archives[0]!.state).toBe('missing')
    renameSync(`${path}.preč`, path)
    await archives.init()
    expect(archives.list().archives[0]!.state).toBe('ready')
    expect((await archives.view(id, {})).subject).toBeTruthy()
  })

  it('súbor, ktorý nie je mbox → chyba, nič sa nezmaže', async () => {
    const p = join(dir, 'nie.mbox')
    writeFileSync(p, 'Subject: x\n\ntext\n')
    files.allow(p, 'read')
    const { archiveId: id } = await archives.open(p)
    await archives.wait(id)
    expect(archives.list().archives.find((a) => a.id === id)).toMatchObject({ state: 'failed', error: 'NOT_MBOX' })
    expect(readFileSync(p, 'utf8')).toBe('Subject: x\n\ntext\n')
    await archives.close(id)
  })

  it('zatvorenie: zoznam a fulltext zmiznú z Doaru, súbor zostane', async () => {
    const before = sha(path)
    await archives.close(archiveId)
    expect(archives.list()).toEqual({ archives: [], folders: [] })
    expect((db.prepare('SELECT COUNT(*) AS c FROM archive_messages').get() as { c: number }).c).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) AS c FROM archive_fts WHERE archive_fts MATCH 'faktura*'`).get() as { c: number }).c).toBe(0)
    expect(sha(path)).toBe(before)
  })
})
