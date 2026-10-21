import { describe, it, expect } from 'vitest'
import {
  asctime, canonicalize, encodeFolderPath, decodeFolderPath, encodeMessage, envelopeSender, metadataBlock, sha256, splitMboxrd, stripDoarBlock, type MessageMeta
} from '../../src/core/export/mboxrd'

const meta = (over: Partial<MessageMeta> = {}): MessageMeta => ({
  source: 'jan@firma.sk',
  folderSegments: ['INBOX', 'Faktúry 2026'],
  specialUse: null,
  internalDate: new Date('2026-10-01T09:05:03Z'),
  flags: new Set(['\\Seen', '\\Flagged', '$Forwarded', '\\Recent']),
  ...over
})

const RAW = Buffer.from(
  'Return-Path: <jan@firma.sk>\r\nFrom: Ján <jan@firma.sk>\r\nSubject: Test\r\nStatus: O\r\nX-Doar-Folder: podvrh\r\n\r\nFrom the beginning\r\n>From quoted\r\n>>From deeper\r\nFromage nie je oddeľovač\r\n\r\nKoniec',
  'latin1'
)

describe('formát mboxrd', () => {
  it('kódovanie priečinkov: Unicode, medzera, %, lomka v názve', () => {
    expect(encodeFolderPath(['INBOX', 'Faktúry 2026'])).toBe('INBOX/Fakt%C3%BAry%202026')
    expect(encodeFolderPath(['Plán 100% / hotový'])).toBe('Pl%C3%A1n%20100%25%20%2F%20hotov%C3%BD')
    expect(encodeFolderPath(['[Gmail]', 'All Mail'])).toBe('[Gmail]/All%20Mail')
    for (const segs of [['INBOX', 'Faktúry 2026'], ['Plán 100% / hotový'], ['日本語', 'ä', 'x']]) {
      expect(decodeFolderPath(encodeFolderPath(segs))).toEqual(segs)
    }
  })

  it('asctime a odosielateľ v oddeľovači', () => {
    expect(asctime(new Date('2026-10-01T09:05:03Z'))).toBe('Thu Oct  1 09:05:03 2026')
    expect(asctime(new Date('2026-10-21T14:36:00Z'))).toBe('Wed Oct 21 14:36:00 2026')
    expect(envelopeSender(canonicalize(RAW))).toBe('jan@firma.sk')
    expect(envelopeSender(canonicalize(Buffer.from('Return-Path: <>\r\n\r\nx')))).toBe('MAILER-DAEMON')
    expect(envelopeSender(canonicalize(Buffer.from('Subject: x\r\n\r\nx')))).toBe('MAILER-DAEMON')
  })

  it('kanonický tvar: CRLF všade a na konci', () => {
    expect(canonicalize(Buffer.from('a\nb\rc\r\nd')).toString()).toBe('a\r\nb\r\nc\r\nd\r\n')
  })

  it('blok metadát: pevné poradie, počet riadkov, Status/X-Status, bez \\Recent', () => {
    const b = metadataBlock(meta(), 'ab'.repeat(32))
    expect(b[0]).toBe(`X-Doar-Version: 1; lines=${b.length}`)
    expect(b).toEqual([
      'X-Doar-Version: 1; lines=10',
      'X-Doar-Source: jan@firma.sk',
      'X-Doar-Folder: INBOX/Fakt%C3%BAry%202026',
      'X-Doar-Special-Use:',
      'X-Doar-Internal-Date: 2026-10-01T09:05:03Z',
      'X-Doar-Flags: \\Seen \\Flagged',
      'X-Doar-Keywords: $Forwarded',
      `X-Doar-Hash: sha256=${'ab'.repeat(32)}`,
      'Status: RO',
      'X-Status: F'
    ])
    const unread = metadataBlock(meta({ flags: new Set(), specialUse: '\\Inbox' }), 'cd'.repeat(32))
    expect(unread).toContain('Status: O')
    expect(unread).toContain('X-Doar-Special-Use: \\Inbox')
    expect(unread.some((l) => l.startsWith('X-Status'))).toBe(false)
  })

  it('správa: escapovanie >From, LF, prázdny riadok na konci; obnova vráti presný originál', () => {
    const { chunk, hash } = encodeMessage(RAW, meta())
    const text = chunk.toString('latin1')
    expect(text.startsWith('From jan@firma.sk Thu Oct  1 09:05:03 2026\nX-Doar-Version: 1; lines=10\n')).toBe(true)
    expect(text).toContain('\n>From the beginning\n>>From quoted\n>>>From deeper\nFromage nie je')
    expect(text).not.toContain('\r')
    expect(text.endsWith('Koniec\n\n')).toBe(true)

    // Dve správy za sebou → čítanie ich rozdelí správne.
    const two = Buffer.concat([chunk, encodeMessage(Buffer.from('Subject: druha\r\n\r\nFrom x\r\n'), meta({ folderSegments: ['Sent'] })).chunk])
    const parsed = splitMboxrd(two)
    expect(parsed).toHaveLength(2)
    const r = stripDoarBlock(parsed[0]!.message)
    expect(r.hashOk).toBe(true)
    expect(r.block!.hash).toBe(hash)
    expect(r.original.equals(canonicalize(RAW))).toBe(true)
    expect(sha256(r.original)).toBe(hash)
    // Pôvodné hlavičky Status a X-Doar-Folder v správe ostali nedotknuté.
    expect(r.original.toString('latin1')).toContain('\r\nStatus: O\r\nX-Doar-Folder: podvrh\r\n')
    expect(r.block!.folderSegments).toEqual(['INBOX', 'Faktúry 2026'])
    expect([...r.block!.flags].sort()).toEqual(['$Forwarded', '\\Flagged', '\\Seen'])
    expect(r.block!.internalDate?.toISOString()).toBe('2026-10-01T09:05:03.000Z')
    expect(stripDoarBlock(parsed[1]!.message).original.toString()).toBe('Subject: druha\r\n\r\nFrom x\r\n')
  })

  it('upravená správa → hash nesedí; cudzia správa bez bloku ostane celá', () => {
    const { chunk } = encodeMessage(RAW, meta())
    const tampered = Buffer.from(chunk.toString('latin1').replace('Koniec', 'Koniek'), 'latin1')
    expect(stripDoarBlock(splitMboxrd(tampered)[0]!.message).hashOk).toBe(false)
    const foreign = splitMboxrd(Buffer.from('From a@b Thu Oct  1 09:05:03 2026\nSubject: x\nStatus: RO\n\nahoj\n\n'))
    const f = stripDoarBlock(foreign[0]!.message)
    expect(f.block).toBeNull()
    expect(f.original.toString()).toBe('Subject: x\r\nStatus: RO\r\n\r\nahoj\r\n')
  })

  it('8-bitový obsah (iné kódovanie ako UTF-8) prejde bez zmeny', () => {
    const raw = Buffer.concat([Buffer.from('Subject: x\r\nContent-Type: text/plain; charset=windows-1250\r\n\r\n'), Buffer.from([0x9a, 0xe8, 0xbe, 0xfd, 0x0d, 0x0a])])
    const r = stripDoarBlock(splitMboxrd(encodeMessage(raw, meta()).chunk)[0]!.message)
    expect(r.hashOk).toBe(true)
    expect(r.original.equals(raw)).toBe(true)
  })
})
