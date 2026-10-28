import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../../src/core/store/db'
import { MailStore, type HeaderInput } from '../../src/core/store/mailstore'
import { firstMessageId, isReplySubject, threadSubject } from '../../src/core/mail/thread'

let db: Db
let store: MailStore
let uid = 0

function h(p: Partial<HeaderInput> & { day: number }): HeaderInput {
  uid++
  return {
    uid,
    size: 10,
    internalDate: `2026-10-${String(p.day).padStart(2, '0')}T10:00:00.000Z`,
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

const idOf = (folderId: number, subject: string): number =>
  (db.prepare('SELECT id FROM messages WHERE folder_id = ? AND subject = ?').get(folderId, subject) as { id: number }).id

beforeEach(() => {
  uid = 0
  db = openDb(':memory:')
  store = new MailStore(db)
  db.prepare(`INSERT INTO accounts(id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username)
    VALUES (1,'ja@doar.test','imap',993,'tls','smtp',465,'tls','ja'), (2,'druhe@doar.test','imap',993,'tls','smtp',465,'tls','d')`).run()
  db.prepare(`INSERT INTO folders(id,account_id,path,name,special_use) VALUES (1,1,'INBOX','INBOX','inbox'), (2,1,'Sent','Sent','sent'), (3,1,'Trash','Trash','trash'), (4,2,'INBOX','INBOX','inbox')`).run()
})

describe('konverzácie: pomocné funkcie', () => {
  it('predmet bez predpôn a diakritiky; rozpoznanie odpovede', () => {
    expect(threadSubject('Re: AW: Fwd: [tím] Faktúra ZA október')).toBe('faktura za oktober')
    expect(threadSubject('Odp: Odp: Obed')).toBe('obed')
    expect(isReplySubject('[tím] Re: x')).toBe(true)
    expect(isReplySubject('Rezervácia')).toBe(false)
    expect(firstMessageId('<a@b> <c@d>')).toBe('<a@b>')
    expect(firstMessageId(null)).toBeNull()
  })
})

describe('konverzácie: zaradenie a zoznam', () => {
  it('odpovede podľa In-Reply-To, aj keď odpoveď príde skôr; vlastná odpoveď z Odoslaných', () => {
    // Odpoveď prišla skôr než pôvodná správa (iný priečinok sa synchronizoval prv).
    store.insertHeaders(1, 1, [h({ day: 3, subject: 'Re: Obed', messageId: '<b@x>', inReplyTo: '<a@x>', flags: new Set() })])
    store.insertHeaders(1, 1, [h({ day: 1, subject: 'Obed', messageId: '<a@x>' })])
    store.insertHeaders(1, 2, [h({ day: 2, subject: 'Re: Obed', messageId: '<s@x>', inReplyTo: '<a@x>', fromAddr: 'ja@doar.test', fromName: 'Ja' })])
    store.insertHeaders(1, 1, [h({ day: 5, subject: 'Iná vec', messageId: '<z@x>' })])
    const key = (id: number) => (db.prepare('SELECT thread_key FROM messages WHERE id = ?').get(id) as { thread_key: string }).thread_key
    expect(key(idOf(1, 'Obed'))).toBe(key(idOf(1, 'Re: Obed')))
    expect(key(idOf(2, 'Re: Obed'))).toBe(key(idOf(1, 'Obed')))
    expect(key(idOf(1, 'Iná vec'))).not.toBe(key(idOf(1, 'Obed')))

    const list = store.listThreads(1, 0, 50)
    expect(list.total).toBe(2)
    expect(list.items.map((m) => m.subject)).toEqual(['Iná vec', 'Re: Obed'])
    const conv = list.items[1]!
    expect(conv.threadIds).toEqual([idOf(1, 'Obed'), idOf(1, 'Re: Obed')])
    expect(conv.seen).toBe(false) // neprečítaná odpoveď → celá konverzácia neprečítaná
    expect(conv.threadFrom).toEqual(['Ján'])
    expect(list.items[0]!.threadIds).toBeUndefined()
    expect(store.listThreadIds(1)).toEqual([idOf(1, 'Iná vec'), idOf(1, 'Re: Obed')])

    // Čítanie: celá konverzácia vrátane vlastnej odpovede v Odoslaných, od najstaršej.
    expect(store.threadMessages(idOf(1, 'Re: Obed')).map((m) => [m.folderId, m.fromName])).toEqual([
      [1, 'Ján'],
      [2, 'Ja'],
      [1, 'Ján']
    ])
  })

  it('odpoveď bez známeho predchodcu: podľa predmetu do 60 dní; bežná správa s rovnakým predmetom nie', () => {
    store.insertHeaders(1, 1, [h({ day: 1, subject: 'Faktúra 10/2026', messageId: '<f1@x>' })])
    store.insertHeaders(1, 1, [h({ day: 4, subject: 'RE: Faktura 10/2026', messageId: '<f2@x>', inReplyTo: '<nemam@x>' })])
    store.insertHeaders(1, 1, [h({ day: 6, subject: 'Faktúra 10/2026', messageId: '<f3@x>' })])
    expect(store.listThreads(1, 0, 50).total).toBe(2)
  })

  it('References zo stiahnutej správy spoja konverzáciu; Kôš sa v čítaní neukazuje; kontá sa nemiešajú', () => {
    store.insertHeaders(1, 1, [h({ day: 1, subject: 'Projekt', messageId: '<p1@x>' })])
    // Odpoveď na stratenú medzisprávu – spojí ju až References z tela.
    store.insertHeaders(1, 1, [h({ day: 3, subject: 'Projekt – termín', messageId: '<p3@x>', inReplyTo: '<p2@x>' })])
    expect(store.listThreads(1, 0, 50).total).toBe(2)
    store.setBody(idOf(1, 'Projekt – termín'), 'a'.repeat(64), { snippet: '', hasAttachments: false, bodyText: '', references: ['<p1@x>', '<p2@x>'] })
    expect(store.listThreads(1, 0, 50).total).toBe(1)

    store.insertHeaders(1, 3, [h({ day: 2, subject: 'Re: Projekt', messageId: '<t@x>', inReplyTo: '<p1@x>' })])
    expect(store.threadMessages(idOf(1, 'Projekt')).map((m) => m.folderId)).toEqual([1, 1])
    expect(store.threadMessages(idOf(3, 'Re: Projekt')).map((m) => m.folderId)).toEqual([1, 3, 1])

    // Tá istá správa v druhom konte – iná konverzácia (spoločná doručená pošta ich nespojí).
    store.insertHeaders(2, 4, [h({ day: 1, subject: 'Projekt', messageId: '<p1@x>' })])
    expect(store.listThreads(null, 0, 50).total).toBe(2)
  })

  it('doplnenie konverzácií staršej pošte po aktualizácii', () => {
    store.insertHeaders(1, 1, [h({ day: 1, subject: 'A', messageId: '<a1@x>' }), h({ day: 2, subject: 'Re: A', messageId: '<a2@x>', inReplyTo: '<a1@x>' })])
    db.exec('UPDATE messages SET thread_key = NULL, thread_subject = NULL')
    expect(store.backfillThreads(1)).toBe(1)
    expect(store.backfillThreads()).toBe(1)
    expect(store.backfillThreads()).toBe(0)
    expect(store.listThreads(1, 0, 50).total).toBe(1)
  })
})

describe('rozšírené hľadanie v úložisku', () => {
  it('filtre bez textu aj s textom: príloha, neprečítané, hviezdička, dátum', async () => {
    const { buildSearch } = await import('../../src/core/search')
    store.insertHeaders(1, 1, [
      h({ day: 1, subject: 'Faktúra september', flags: new Set() }),
      h({ day: 10, subject: 'Faktúra október', flags: new Set(['\\Seen', '\\Flagged']) }),
      h({ day: 20, subject: 'Pozvánka', flags: new Set() })
    ])
    db.prepare('UPDATE messages SET has_attachments = 1 WHERE subject = ?').run('Faktúra október')
    const subjects = (q: string, f = {}) => store.searchMessages(buildSearch(q, f)!, {}, 0, 50).items.map((m) => m.subject).sort()
    expect(subjects('faktura')).toEqual(['Faktúra október', 'Faktúra september'])
    expect(subjects('', { unread: true })).toEqual(['Faktúra september', 'Pozvánka'])
    expect(subjects('faktura je:neprecitane')).toEqual(['Faktúra september'])
    expect(subjects('', { attachment: true })).toEqual(['Faktúra október'])
    expect(subjects('is:flagged')).toEqual(['Faktúra október'])
    expect(subjects('', { after: '2026-10-05', before: '2026-10-10' })).toEqual(['Faktúra október'])
    expect(store.searchIds(buildSearch('po:15.10.2026')!, {})).toEqual([idOf(1, 'Pozvánka')])
  })
})
