import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { simpleParser } from 'mailparser'
import { dbxFolders as writeFolders, dbxMessages } from '../fixtures/dbx-writer'
import { dbxInfo, readDbx, NotDbxError } from '../../src/core/import/sources/dbx'
import { emlInfo, readEml } from '../../src/core/import/sources/eml'
import { pstInfo, readPst } from '../../src/core/import/sources/pst'
import { convertSource, detectSource } from '../../src/core/import/sources'
import { decodeAnsi, specialUseFor, type SourceMessage } from '../../src/core/import/sources/common'
import { splitMboxrd, stripDoarBlock } from '../../src/core/export/mboxrd'
import { parseEntry, readMbox } from '../../src/core/import/mbox-reader'

const ENRON = join(import.meta.dirname, '../../node_modules/pst-extractor/example/testdata/enron.pst')

const mail = (subject: string, body = 'Text správy.', date = 'Wed, 01 Oct 2003 09:00:00 +0000'): Buffer =>
  Buffer.from(`From: Ján <jan@firma.sk>\r\nTo: eva@firma.sk\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@firma.sk>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`, 'utf8')

async function collect(gen: AsyncGenerator<SourceMessage>): Promise<SourceMessage[]> {
  const out: SourceMessage[] = []
  for await (const m of gen) out.push(m)
  return out
}

describe('Outlook Express (.dbx)', () => {
  let dir: string
  const inbox = Array.from({ length: 33 }, (_, i) => mail(`Sprava ${i + 1}`))
  const big = mail('Velka', 'x'.repeat(5000) + '\r\nkoniec')

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'doar-dbx-'))
    // Hierarchia ako v OE6: koreň → Miestne priečinky (bez súboru) → Doručená pošta → Projekty; Odoslaná pošta.
    writeFileSync(
      join(dir, 'Folders.dbx'),
      writeFolders([
        { id: 0, parent: 0, name: 'Outlook Express' },
        { id: 1, parent: 0, name: 'Miestne priečinky' },
        { id: 2, parent: 1, name: 'Doručená pošta', file: 'Doručená pošta.dbx' },
        { id: 3, parent: 2, name: 'Projekty', file: 'Projekty.dbx' },
        { id: 4, parent: 1, name: 'Odoslaná pošta', file: 'Odoslaná pošta.dbx' }
      ])
    )
    writeFileSync(
      join(dir, 'Doručená pošta.dbx'),
      dbxMessages([
        ...inbox.map((raw, i) => ({ raw, flags: i % 2 ? 0x80 : 0, received: new Date(Date.UTC(2003, 9, 1, 10, i)) })),
        { raw: big, flags: 0x80 | 0x80000 }
      ])
    )
    writeFileSync(join(dir, 'Projekty.dbx'), dbxMessages([{ raw: mail('Projekt A'), flags: 0x80 }]))
    writeFileSync(join(dir, 'Odoslaná pošta.dbx'), dbxMessages([{ raw: mail('Odoslana'), flags: 0x80 }]))
    writeFileSync(join(dir, 'Pop3uidl.dbx'), Buffer.alloc(100))
  })

  it('priečinky, hierarchia, počet správ', async () => {
    expect(await dbxInfo(dir)).toEqual({ format: 'dbx', messages: 36, folders: 3 })
    expect(await detectSource(dir)).toBe('dbx')
  })

  it('správy: obsah bit po bite (aj cez viac blokov), priečinok, príznaky, dátum prijatia', async () => {
    const all = await collect(readDbx(dir))
    expect(all).toHaveLength(36)
    const inInbox = all.filter((m) => m.folder.join('/') === 'Doručená pošta')
    expect(inInbox.map((m) => m.raw.toString())).toEqual([...inbox, big].map((b) => b.toString()))
    expect(inInbox[1]!.flags).toEqual(new Set(['\\Seen']))
    expect(inInbox[0]!.flags).toEqual(new Set())
    expect(inInbox[33]!.flags).toEqual(new Set(['\\Seen', '\\Answered']))
    expect(inInbox[5]!.internalDate?.toISOString()).toBe('2003-10-01T10:05:00.000Z')
    expect(inInbox[33]!.internalDate?.toISOString()).toBe('2003-10-01T09:00:00.000Z') // bez dátumu prijatia → hlavička Date
    expect(all.find((m) => m.raw.includes('Projekt A'))!.folder).toEqual(['Doručená pošta', 'Projekty'])
    expect(all.find((m) => m.raw.includes('Odoslana'))!.folder).toEqual(['Odoslaná pošta'])
    expect(specialUseFor(['Doručená pošta'])).toBe('\\Inbox')
    expect(specialUseFor(['Odoslaná pošta'])).toBe('\\Sent')
    expect(specialUseFor(['Doručená pošta', 'Projekty'])).toBeNull()
  })

  it('jeden súbor .dbx (bez Folders.dbx) = jeden priečinok podľa názvu', async () => {
    const one = await collect(readDbx(join(dir, 'Projekty.dbx')))
    expect(one).toHaveLength(1)
    expect(one[0]!.folder).toEqual(['Projekty'])
    const viaIndex = await collect(readDbx(join(dir, 'Folders.dbx')))
    expect(viaIndex).toHaveLength(36)
  })

  it('iný súbor nie je .dbx', async () => {
    const f = join(dir, 'zle.dbx')
    writeFileSync(f, Buffer.alloc(0x3000, 7))
    await expect(dbxInfo(f)).rejects.toBeInstanceOf(NotDbxError)
  })
})

describe('Windows Mail / Windows Live Mail (.eml)', () => {
  it('priečinky ako na disku, správy ako prečítané, dátum z hlavičky', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doar-eml-'))
    mkdirSync(join(dir, 'Inbox', 'Faktúry'), { recursive: true })
    mkdirSync(join(dir, 'Sent Items'))
    writeFileSync(join(dir, 'Inbox', '{A1}.eml'), mail('Prva'))
    writeFileSync(join(dir, 'Inbox', 'Faktúry', '{B2}.eml'), mail('Faktura'))
    writeFileSync(join(dir, 'Sent Items', '{C3}.eml'), mail('Odoslana', 'x', 'nie je datum'))
    writeFileSync(join(dir, 'Inbox', 'poznamka.txt'), 'nie je e-mail')
    writeFileSync(join(dir, 'Inbox', 'pokazene.eml'), 'toto nie je e-mail')
    utimesSync(join(dir, 'Sent Items', '{C3}.eml'), new Date('2004-02-03T04:05:06Z'), new Date('2004-02-03T04:05:06Z'))
    expect(await emlInfo(dir)).toMatchObject({ format: 'eml', messages: 4 })
    expect(await detectSource(dir)).toBe('eml')
    let skipped = 0
    const all = await collect(readEml(dir, { onSkip: () => skipped++ }))
    expect(skipped).toBe(1)
    expect(all.map((m) => [m.folder.join('/'), m.raw.toString().match(/Subject: (\w+)/)![1]])).toEqual([
      ['Inbox', 'Prva'],
      ['Inbox/Faktúry', 'Faktura'],
      ['Sent Items', 'Odoslana']
    ])
    expect(all.every((m) => m.flags.has('\\Seen'))).toBe(true)
    expect(all[0]!.internalDate?.toISOString()).toBe('2003-10-01T09:00:00.000Z')
    expect(all[2]!.internalDate?.toISOString()).toBe('2004-02-03T04:05:06.000Z') // bez Date → čas súboru
    // Vybraný priamo priečinok so správami: patria do priečinka s jeho názvom.
    const inbox = await collect(readEml(join(dir, 'Inbox', 'Faktúry')))
    expect(inbox[0]!.folder).toEqual(['Faktúry'])
  })
})

describe('Outlook (.pst)', () => {
  it('priečinky pošty bez koreňa a vyhľadávacích priečinkov; správy sa dajú rozložiť', async () => {
    const info = pstInfo(ENRON)
    expect(info).toEqual({ format: 'pst', messages: 71, folders: 5 })
    expect(await detectSource(ENRON)).toBe('pst')
    const all = await collect(readPst(ENRON))
    expect(all).toHaveLength(71)
    expect(new Set(all.map((m) => m.folder.join('/')))).toEqual(
      new Set(['lokay-m/MLOKAY (Non-Privileged)', 'lokay-m/MLOKAY (Non-Privileged)/TW-Commercial Group', 'lokay-m/MLOKAY (Non-Privileged)/Systems', 'lokay-m/MLOKAY (Non-Privileged)/Sent Items', 'lokay-m/MLOKAY (Non-Privileged)/Personal'])
    )
    const parsed = await simpleParser(all.find((m) => m.raw.includes('Cirque du Soleil'))!.raw)
    expect(parsed.subject).toBe('Cirque du Soleil - Dralion')
    expect(parsed.messageId).toBe('<CTBITLRPOWHBS4AJABL1YK4IP2J3324IA@zlsvr22>')
    expect(parsed.text).toContain('Mark your calendars!')
    const withAtt = await simpleParser(all.find((m) => m.raw.includes('Power Mart'))!.raw)
    expect(withAtt.attachments.length).toBeGreaterThan(0)
    expect(all.filter((m) => m.flags.has('\\Seen')).length).toBeGreaterThan(0)
  }, 60_000)
})

describe('prevod do formátu zálohy Doar', () => {
  it('Outlook Express → mbox s metadátami: štandardné priečinky, rovnaký výsledok pri opakovaní, čitateľné obnovou', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doar-conv-'))
    writeFileSync(join(dir, 'Folders.dbx'), writeFolders([{ id: 1, parent: 0, name: 'Inbox', file: 'Inbox.dbx' }, { id: 2, parent: 0, name: 'Sent Items', file: 'Sent Items.dbx' }]))
    writeFileSync(join(dir, 'Inbox.dbx'), dbxMessages([{ raw: mail('Prva'), flags: 0x80 }, { raw: mail('Druha') }]))
    writeFileSync(join(dir, 'Sent Items.dbx'), dbxMessages([{ raw: mail('Odoslana'), flags: 0x80 }]))
    const a = join(dir, 'a.mbox')
    const b = join(dir, 'b.mbox')
    const progress: [number, number][] = []
    expect(await convertSource('dbx', dir, a, { onProgress: (d, t) => progress.push([d, t]) })).toEqual({ messages: 3, skipped: 0 })
    await convertSource('dbx', dir, b)
    expect(existsSync(`${a}.part`)).toBe(false)
    expect(progress.at(-1)).toEqual([3, 3])
    const h = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex')
    expect(h(a)).toBe(h(b))
    const entries = splitMboxrd(readFileSync(a)).map((e) => stripDoarBlock(e.message))
    expect(entries.map((e) => [e.block!.specialUse, e.block!.folderSegments.join('/'), [...e.block!.flags].join(' '), e.hashOk])).toEqual([
      ['\\Inbox', 'Inbox', '\\Seen', true],
      ['\\Inbox', 'Inbox', '', true],
      ['\\Sent', 'Sent Items', '\\Seen', true]
    ])
    // Obnova číta súbor rovnako ako zálohu Doar.
    const parsed = []
    for await (const e of readMbox(a)) parsed.push(parseEntry(e.raw)!)
    expect(parsed.map((p) => [p.doar, p.specialUse, p.source])).toEqual([
      [true, '\\Inbox', 'Outlook Express'],
      [true, '\\Inbox', 'Outlook Express'],
      [true, '\\Sent', 'Outlook Express']
    ])
    expect(parsed[0]!.original.toString()).toBe(mail('Prva').toString())
  })

  it('Outlook: opakovaný prevod dá ten istý súbor (opakovaný import nič nezdvojí)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doar-conv-pst-'))
    await convertSource('pst', ENRON, join(dir, 'a.mbox'))
    await convertSource('pst', ENRON, join(dir, 'b.mbox'))
    expect(readFileSync(join(dir, 'a.mbox')).equals(readFileSync(join(dir, 'b.mbox')))).toBe(true)
  }, 60_000)

  it('bez správ → chyba, žiadny polovičný súbor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doar-conv-empty-'))
    mkdirSync(join(dir, 'Inbox'))
    writeFileSync(join(dir, 'Inbox', 'x.eml'), 'nie je e-mail')
    await expect(convertSource('eml', dir, join(dir, 'out.mbox'))).rejects.toMatchObject({ code: 'NO_MESSAGES' })
    expect(existsSync(join(dir, 'out.mbox'))).toBe(false)
    expect(existsSync(join(dir, 'out.mbox.part'))).toBe(false)
  })
})

describe('kódovanie názvov priečinkov (Outlook Express)', () => {
  it('UTF-8, stredoeurópske a západné kódovanie Windows', () => {
    expect(decodeAnsi(Buffer.from('Doručená pošta', 'utf8'))).toBe('Doručená pošta')
    expect(decodeAnsi(Buffer.from([0x44, 0x6f, 0x72, 0x75, 0xe8, 0x65, 0x6e, 0xe1]))).toBe('Doručená')
    expect(decodeAnsi(Buffer.from([0x45, 0x6e, 0x74, 0x77, 0xfc, 0x72, 0x66, 0x65]))).toBe('Entwürfe')
    expect(decodeAnsi(Buffer.from('Inbox'))).toBe('Inbox')
  })
})
