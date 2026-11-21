import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../../src/core/store/db'
import { MailStore, markFromKeywords, type HeaderInput } from '../../src/core/store/mailstore'
import { buildSearch } from '../../src/core/search'

let db: Db
let store: MailStore
let uid = 0

function h(p: Partial<HeaderInput> & { day: number }): HeaderInput {
  uid++
  return {
    uid,
    size: 10,
    internalDate: `2026-11-${String(p.day).padStart(2, '0')}T10:00:00.000Z`,
    dateHeader: null,
    messageId: null,
    inReplyTo: null,
    subject: '',
    fromAddr: 'jan@firma.sk',
    fromName: 'Ján',
    to: [],
    cc: [],
    flags: new Set(['\\Seen']),
    ...p
  }
}

const idOf = (subject: string): number => (db.prepare('SELECT id FROM messages WHERE subject = ?').get(subject) as { id: number }).id
const markOf = (subject: string): number => (db.prepare('SELECT mark FROM messages WHERE subject = ?').get(subject) as { mark: number }).mark
const serverFlags = (subject: string, flags: string[]) => ({ uid: (db.prepare('SELECT uid FROM messages WHERE subject = ?').get(subject) as { uid: number }).uid, flags: new Set(flags) })

beforeEach(() => {
  uid = 0
  db = openDb(':memory:')
  store = new MailStore(db)
  db.prepare(`INSERT INTO accounts(id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username)
    VALUES (1,'ja@doar.test','imap',993,'tls','smtp',465,'tls','ja')`).run()
  db.prepare(`INSERT INTO folders(id,account_id,path,name,special_use) VALUES (1,1,'INBOX','INBOX','inbox')`).run()
})

describe('stav vybavenia (krúžok)', () => {
  it('značka zo servera určí stav; bez našej značky žiadny stav', () => {
    expect(markFromKeywords(['$DoarHigh'])).toBe(1)
    expect(markFromKeywords(['$Label1', '$DoarDone'])).toBe(3)
    expect(markFromKeywords(['$Label1'])).toBe(0)
    store.insertHeaders(1, 1, [
      h({ day: 1, subject: 'Faktúra', flags: new Set(['\\Seen', '$DoarMedium']) }),
      h({ day: 2, subject: 'Obed' })
    ])
    expect(markOf('Faktúra')).toBe(2)
    expect(markOf('Obed')).toBe(0)
    expect(store.listMessages(1, 0, 50).items.find((m) => m.subject === 'Faktúra')!.mark).toBe(2)
  })

  it('filter: viac stavov naraz, v zozname, ID aj v hľadaní', () => {
    store.insertHeaders(1, 1, [h({ day: 1, subject: 'Zmluva' }), h({ day: 2, subject: 'Faktúra' }), h({ day: 3, subject: 'Obed' }), h({ day: 4, subject: 'Hotovo' })])
    store.setLocalFlags([idOf('Zmluva')], { mark: 1 })
    store.setLocalFlags([idOf('Faktúra')], { mark: 2 })
    store.setLocalFlags([idOf('Hotovo')], { mark: 3 })

    const list = store.listMessages(1, 0, 50, [1, 2])
    expect(list.total).toBe(2)
    expect(list.items.map((m) => m.subject).sort()).toEqual(['Faktúra', 'Zmluva'])
    expect(store.listIds(1, [3])).toEqual([idOf('Hotovo')])
    expect(store.listMessages(1, 0, 50, []).total).toBe(4) // prázdny filter = všetko
    expect(store.listMessages(null, 0, 50, [1]).items.map((m) => m.subject)).toEqual(['Zmluva'])

    const fts = buildSearch('faktúra')!
    expect(store.searchMessages(fts, { folderId: 1 }, 0, 50, [1]).total).toBe(0)
    expect(store.searchMessages(fts, { folderId: 1 }, 0, 50, [2]).total).toBe(1)
    expect(store.searchIds(fts, { folderId: 1 }, [2])).toEqual([idOf('Faktúra')])
  })

  it('konverzácia ukazuje najnaliehavejší stav a filter ju nájde', () => {
    store.insertHeaders(1, 1, [
      h({ day: 1, subject: 'Ponuka', messageId: '<a@x>' }),
      h({ day: 2, subject: 'Re: Ponuka', messageId: '<b@x>', inReplyTo: '<a@x>' }),
      h({ day: 3, subject: 'Iné' })
    ])
    store.setLocalFlags([idOf('Ponuka')], { mark: 3 })
    store.setLocalFlags([idOf('Re: Ponuka')], { mark: 1 })
    const conv = store.listThreads(1, 0, 50).items.find((m) => m.threadIds)!
    expect(conv.mark).toBe(1)
    expect(store.listThreads(1, 0, 50, [1]).total).toBe(1)
    expect(store.listThreads(1, 0, 50, [2]).total).toBe(0)
    expect(store.listThreadIds(1, [1, 3])).toHaveLength(1)
  })

  it('synchronizácia: server so značkami prepíše stav, server bez nich ho nechá', () => {
    store.insertHeaders(1, 1, [h({ day: 1, subject: 'A' }), h({ day: 2, subject: 'B', flags: new Set(['$DoarHigh']) })])
    // A: stav nastavený v Doare, server vlastné značky neuložil (nikdy ich nevráti) → stav ostáva.
    store.setLocalFlags([idOf('A')], { mark: 2 })
    store.setLocalState([idOf('A')], 'synced')
    store.applyServerFlags(1, [serverFlags('A', ['\\Seen'])])
    expect(markOf('A')).toBe(2)
    // B: značku na serveri zmenili inde (iný počítač) → prevezme sa.
    store.applyServerFlags(1, [serverFlags('B', ['$DoarDone'])])
    expect(markOf('B')).toBe(3)
    // B: značku na serveri zrušili → stav sa zruší.
    store.applyServerFlags(1, [serverFlags('B', [])])
    expect(markOf('B')).toBe(0)
  })

  it('kým zmena čaká na odoslanie, server stav neprepíše', () => {
    store.insertHeaders(1, 1, [h({ day: 1, subject: 'C', flags: new Set(['$DoarHigh']) })])
    store.setLocalFlags([idOf('C')], { mark: 3 })
    store.applyServerFlags(1, [serverFlags('C', ['$DoarHigh'])])
    expect(markOf('C')).toBe(3)
  })
})
