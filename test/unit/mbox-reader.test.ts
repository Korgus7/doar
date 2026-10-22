import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalize, encodeMessage, sha256, type MessageMeta } from '../../src/core/export/mboxrd'
import { looksLikeSeparator, parseEntry, peekMbox, readEntryAt, readMbox, separatorDate, weakKey, NotMboxError } from '../../src/core/import/mbox-reader'
import { targetDesc } from '../../src/core/import/import-account'

const dir = mkdtempSync(join(tmpdir(), 'doar-mbox-reader-'))
let n = 0
const file = (data: Buffer | string): string => {
  const p = join(dir, `f${++n}.mbox`)
  writeFileSync(p, typeof data === 'string' ? Buffer.from(data, 'latin1') : data)
  return p
}

async function all(path: string): Promise<{ offset: number; length: number; raw: Buffer }[]> {
  const out = []
  for await (const e of readMbox(path)) out.push(e)
  return out
}

const meta = (over: Partial<MessageMeta> = {}): MessageMeta => ({
  source: 'jan@firma.sk',
  folderSegments: ['INBOX', 'Faktúry 2026'],
  specialUse: null,
  internalDate: new Date('2026-10-01T09:05:03Z'),
  flags: new Set(['\\Seen', '\\Flagged', '$Forwarded']),
  ...over
})

const msg = (subject: string, body: string, extra = ''): Buffer =>
  Buffer.from(`From: Jan <jan@firma.sk>\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@firma.sk>\r\nDate: Wed, 01 Oct 2026 09:00:00 +0000\r\n${extra}\r\n${body}`, 'utf8')

describe('čítanie mbox prúdom', () => {
  it('záloha Doar: presný originál, metadáta, hash sedí (aj správa končiaca prázdnym riadkom a bez CRLF)', async () => {
    const originals = [
      msg('Prvá', 'From the beginning\r\n>From quoted\r\nFromage\r\n\r\nKoniec\r\n'),
      msg('Prazdny riadok na konci', 'text\r\n\r\n'),
      msg('Bez konca', 'posledny riadok bez CRLF'),
      msg('Binárne', 'čšž \u0000\r\nlone\rcr\r\n')
    ]
    const chunks = originals.map((o, i) => encodeMessage(o, meta({ folderSegments: i === 0 ? ['INBOX'] : ['Faktúry', '2026'], specialUse: i === 0 ? '\\Inbox' : null })).chunk)
    const path = file(Buffer.concat(chunks))
    const entries = await all(path)
    expect(entries).toHaveLength(4)
    for (const [i, e] of entries.entries()) {
      const p = parseEntry(e.raw)!
      expect(p.doar).toBe(true)
      expect(p.hashOk).toBe(true)
      expect(p.original.equals(canonicalize(originals[i]!))).toBe(true)
      expect(p.fingerprint).toBe(sha256(canonicalize(originals[i]!)))
      expect(p.internalDate?.toISOString()).toBe('2026-10-01T09:05:03.000Z')
      expect([...p.flags].sort()).toEqual(['$Forwarded', '\\Flagged', '\\Seen'])
      expect(p.source).toBe('jan@firma.sk')
      // Opätovné prečítanie zo známej pozície dá ten istý záznam.
      expect((await readEntryAt(path, e.offset, e.length)).equals(e.raw)).toBe(true)
    }
    expect(parseEntry(entries[0]!.raw)!.specialUse).toBe('\\Inbox')
    expect(parseEntry(entries[1]!.raw)!.folderSegments).toEqual(['Faktúry', '2026'])
    expect(entries[0]!.offset).toBe(0)
    expect(entries.at(-1)!.offset + entries.at(-1)!.length).toBe(Buffer.concat(chunks).length)
  })

  it('veľký súbor cez hranice blokov (1 MB) – žiadna správa sa nerozdelí ani nestratí', async () => {
    const parts: Buffer[] = []
    const originals: Buffer[] = []
    for (let i = 0; i < 60; i++) {
      const body = `${'x'.repeat(76)}\r\n`.repeat(400 + (i % 7) * 13) + `From koniec ${i}\r\n`
      const o = msg(`Správa ${i}`, body)
      originals.push(o)
      parts.push(encodeMessage(o, meta()).chunk)
    }
    const path = file(Buffer.concat(parts))
    const entries = await all(path)
    expect(entries).toHaveLength(60)
    entries.forEach((e, i) => expect(parseEntry(e.raw)!.fingerprint).toBe(sha256(canonicalize(originals[i]!))))
  })

  it('cudzí mbox (mboxo, CRLF): „From “ v texte bez dátumu nie je oddeľovač, príznaky zo Status/X-Status, dátum z oddeľovača', async () => {
    const text = [
      'From jan@firma.sk Wed Oct  1 14:36:00 2026',
      'From: Jan <jan@firma.sk>',
      'Subject: Cudzia',
      'Status: RO',
      'X-Status: AF',
      '',
      'Ahoj,',
      '',
      'From my point of view je to hotové.',
      '',
      'From - Thu Oct  2 08:00:00 2026',
      'From: Eva <eva@firma.sk>',
      'Subject: Druhá',
      'Status: O',
      '',
      'Text',
      ''
    ].join('\r\n')
    const entries = await all(file(text))
    expect(entries).toHaveLength(2)
    const a = parseEntry(entries[0]!.raw)!
    expect(a.doar).toBe(false)
    expect(a.hashOk).toBeNull()
    expect([...a.flags].sort()).toEqual(['\\Answered', '\\Flagged', '\\Seen'])
    expect(a.internalDate?.toISOString()).toBe('2026-10-01T14:36:00.000Z')
    expect(a.original.toString('latin1')).toContain('\r\n\r\nFrom my point of view je to hotové.\r\n')
    expect(a.original.toString()).toContain('Status: RO\r\n') // cudzia správa sa nemení
    const b = parseEntry(entries[1]!.raw)!
    expect([...b.flags]).toEqual([])
    expect(b.weakKey).toBe('d:|eva@firma.sk') // bez Message-ID a Date: odosielateľ
  })

  it('súbor, ktorý nie je mbox, a prázdny súbor', async () => {
    await expect(all(file('Subject: nie mbox\r\n\r\ntext\r\n'))).rejects.toBeInstanceOf(NotMboxError)
    await expect(all(file(''))).rejects.toBeInstanceOf(NotMboxError)
    await expect(peekMbox(file('\r\n\r\nFrom x Wed Oct  1 14:36:00 2026\nSubject: a\n\nb\n'))).resolves.toEqual({ doar: false, source: null })
  })

  it('oddeľovač a jeho dátum', () => {
    expect(looksLikeSeparator('From jan@firma.sk Wed Oct  1 14:36:00 2026')).toBe(true)
    expect(looksLikeSeparator('From - Wed Oct 01 14:36:00 2026')).toBe(true)
    expect(looksLikeSeparator('From 1234@xxx Wed Oct 01 14:36:00 +0000 2026')).toBe(true)
    expect(looksLikeSeparator('From my point of view')).toBe(false)
    expect(separatorDate('From MAILER-DAEMON Thu Jan  1 00:00:00 1970')).toBeNull()
    expect(separatorDate('From 1234@xxx Wed Oct 01 14:36:00 +0000 2026')?.toISOString()).toBe('2026-10-01T14:36:00.000Z')
  })

  it('kľúč pre výber kandidátov na serveri: Message-ID, inak dátum + odosielateľ (bez veľkosti)', () => {
    expect(weakKey('abc@x', 123, 'a@b')).toBe('m:abc@x')
    expect(weakKey('', 123, 'a@b')).toBe('d:123|a@b')
    const p = parseEntry(encodeMessage(msg('K', 'x\r\n'), meta()).chunk)!
    expect(p.weakKey).toBe('m:k@firma.sk')
  })

  it('cieľ podľa metadát: špeciálne priečinky, cesta, Gmail štítky, cudzie správy', () => {
    const base = { doar: true, folderSegments: ['Faktúry', '2026'], specialUse: null, gmailLabels: [] as string[] }
    expect(targetDesc('restore', base)).toBe('path:Fakt%C3%BAry/2026')
    expect(targetDesc('single', base)).toBe('fallback')
    expect(targetDesc('restore', { ...base, doar: false, folderSegments: null })).toBe('fallback')
    expect(targetDesc('restore', { ...base, specialUse: '\\Sent' })).toBe('special:sent')
    expect(targetDesc('restore', { ...base, specialUse: '\\Inbox' })).toBe('special:inbox')
    const gm = { ...base, folderSegments: ['[Gmail]', 'All Mail'], specialUse: '\\All' }
    expect(targetDesc('restore', { ...gm, gmailLabels: ['\\Important', '\\Inbox', 'Práca'] })).toBe('special:inbox')
    expect(targetDesc('restore', { ...gm, gmailLabels: ['\\Sent'] })).toBe('special:sent')
    expect(targetDesc('restore', { ...gm, gmailLabels: ['\\Important', 'Práca/2026'] })).toBe('path:Pr%C3%A1ca/2026')
    expect(targetDesc('restore', { ...gm, gmailLabels: [] })).toBe('special:archive')
    expect(targetDesc('restore', { ...base, specialUse: '\\Trash' })).toBe('special:trash')
  })
})
