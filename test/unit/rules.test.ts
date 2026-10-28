import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../../src/core/store/db'
import { MailStore, type HeaderInput } from '../../src/core/store/mailstore'
import { applyRules, deleteRule, fold, listRules, reorderRules, saveRule, type RuleActions } from '../../src/core/rules'
import { deleteTemplate, listTemplates, saveTemplate } from '../../src/core/templates'

let db: Db
let store: MailStore

function header(uid: number, h: Partial<HeaderInput>): HeaderInput {
  return {
    uid,
    size: 100,
    internalDate: `2026-10-${String(10 + uid).padStart(2, '0')}T08:00:00.000Z`,
    dateHeader: null,
    messageId: `<m${uid}@test>`,
    inReplyTo: null,
    subject: '',
    fromAddr: 'nikto@test.sk',
    fromName: '',
    to: [{ name: 'Ja', address: 'ja@doar.test' }],
    cc: [],
    flags: new Set(),
    ...h
  }
}

/** Zaznamená volania akcií namiesto skutočného presunu (ten testujú integračné testy). */
function recorder(): RuleActions & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    move: (ids, target) => void calls.push(['move', ids, target]),
    setFlags: (ids, change) => void calls.push(['flags', ids, change])
  }
}

beforeEach(() => {
  db = openDb(':memory:')
  store = new MailStore(db)
  db.prepare(`INSERT INTO accounts(id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username)
    VALUES (1,'ja@doar.test','imap',993,'tls','smtp',465,'tls','ja'), (2,'druhe@doar.test','imap',993,'tls','smtp',465,'tls','druhe')`).run()
  db.prepare(`INSERT INTO folders(id,account_id,path,name,special_use) VALUES (1,1,'INBOX','INBOX','inbox'), (2,1,'Novinky','Novinky',NULL), (3,2,'INBOX','INBOX','inbox')`).run()
  store.insertHeaders(1, 1, [
    header(1, { fromName: 'Obchod Šťastný', fromAddr: 'novinky@obchod.sk', subject: 'Akcia týždňa' }),
    header(2, { fromName: 'Ján Novák', fromAddr: 'jan@firma.sk', subject: 'FAKTÚRA za október' }),
    header(3, { fromAddr: 'jan@firma.sk', subject: 'Obed', cc: [{ name: 'Tím', address: 'tim@firma.sk' }], flags: new Set(['\\Seen']) })
  ])
  store.insertHeaders(2, 3, [header(1, { fromAddr: 'novinky@obchod.sk', subject: 'Akcia' })])
})

const id = (folderId: number, uid: number): number => store.messageByUid(folderId, uid)!

describe('pravidlá: ukladanie', () => {
  it('overí text, priečinok a konto; presun platí pre konto priečinka', () => {
    expect(() => saveRule(db, { name: '', enabled: true, accountId: null, field: 'from', value: '  ', action: 'read', folderId: null })).toThrow(
      expect.objectContaining({ code: 'RULE_EMPTY' })
    )
    expect(() => saveRule(db, { name: '', enabled: true, accountId: null, field: 'from', value: 'x', action: 'move', folderId: null })).toThrow(
      expect.objectContaining({ code: 'RULE_NO_FOLDER' })
    )
    expect(() => saveRule(db, { name: '', enabled: true, accountId: 2, field: 'from', value: 'x', action: 'move', folderId: 2 })).toThrow(
      expect.objectContaining({ code: 'CROSS_ACCOUNT' })
    )
    expect(() => saveRule(db, { name: '', enabled: true, accountId: null, field: 'nic' as never, value: 'x', action: 'read', folderId: null })).toThrow(
      expect.objectContaining({ code: 'INVALID' })
    )
    const r = saveRule(db, { name: ' Novinky ', enabled: true, accountId: null, field: 'from', value: ' obchod.sk ', action: 'move', folderId: 2 })
    expect(r).toMatchObject({ name: 'Novinky', accountId: 1, folderId: 2, value: 'obchod.sk', enabled: true })
    // Úprava: priečinok sa pri inej akcii zahodí.
    const u = saveRule(db, { ...r, action: 'read', enabled: false })
    expect(u).toMatchObject({ id: r.id, action: 'read', folderId: null, enabled: false })
    expect(listRules(db)).toHaveLength(1)
  })

  it('poradie a odstránenie', () => {
    const a = saveRule(db, { name: 'A', enabled: true, accountId: null, field: 'subject', value: 'a', action: 'read', folderId: null })
    const b = saveRule(db, { name: 'B', enabled: true, accountId: null, field: 'subject', value: 'b', action: 'read', folderId: null })
    expect(listRules(db).map((r) => r.name)).toEqual(['A', 'B'])
    reorderRules(db, [b.id, a.id])
    expect(listRules(db).map((r) => r.name)).toEqual(['B', 'A'])
    deleteRule(db, b.id)
    expect(listRules(db).map((r) => r.name)).toEqual(['A'])
  })

  it('odstránený priečinok zmaže aj pravidlo, ktoré doň presúvalo', () => {
    saveRule(db, { name: '', enabled: true, accountId: null, field: 'from', value: 'x', action: 'move', folderId: 2 })
    db.prepare('DELETE FROM folders WHERE id = 2').run()
    expect(listRules(db)).toEqual([])
  })
})

describe('pravidlá: použitie', () => {
  it('hľadá bez diakritiky a veľkých písmen v odosielateľovi, adresátoch aj predmete', () => {
    expect(fold('ŠťASTNÝ Ďaleko')).toBe('stastny daleko')
    saveRule(db, { name: '', enabled: true, accountId: null, field: 'from', value: 'stastny', action: 'flag', folderId: null })
    saveRule(db, { name: '', enabled: true, accountId: null, field: 'subject', value: 'faktura', action: 'read', folderId: null })
    saveRule(db, { name: '', enabled: true, accountId: null, field: 'to', value: 'TIM@firma', action: 'flag', folderId: null })
    const act = recorder()
    const r = applyRules(db, store, act, [id(1, 1), id(1, 2), id(1, 3)])
    expect(r.applied).toBe(3)
    // Prečítané sa neoznamujú; hviezdička oznámenie nemení. Už prečítaná správa sa znova neoznačuje.
    expect([...r.handled]).toEqual([id(1, 2)])
    expect(act.calls).toEqual([
      ['flags', [id(1, 2)], { seen: true }],
      ['flags', [id(1, 1), id(1, 3)], { flagged: true }]
    ])
  })

  it('presun ukončí ďalšie pravidlá; konto pravidla sa rešpektuje; vypnuté pravidlo sa nepoužije', () => {
    saveRule(db, { name: '', enabled: true, accountId: null, field: 'from', value: 'obchod.sk', action: 'move', folderId: 2 })
    saveRule(db, { name: '', enabled: true, accountId: null, field: 'any', value: 'akcia', action: 'trash', folderId: null })
    saveRule(db, { name: '', enabled: false, accountId: null, field: 'from', value: 'jan@', action: 'archive', folderId: null })
    const act = recorder()
    const r = applyRules(db, store, act, [id(1, 1), id(1, 2), id(3, 1)])
    expect(act.calls).toEqual([
      ['move', [id(1, 1)], { folderId: 2 }],
      // Druhé konto: presun do priečinka prvého konta sa ho netýka → platí ďalšie pravidlo.
      ['move', [id(3, 1)], { special: 'trash' }]
    ])
    expect([...r.handled].sort()).toEqual([id(1, 1), id(3, 1)].sort())
  })

  it('správa už v cieľovom priečinku sa nepresúva; chyba presunu správu „neoznačí“ ako vybavenú', () => {
    saveRule(db, { name: '', enabled: true, accountId: 1, field: 'from', value: 'jan@firma.sk', action: 'archive', folderId: null })
    const failing: RuleActions = {
      move: () => {
        throw Object.assign(new Error('x'), { code: 'NO_TARGET' })
      },
      setFlags: () => {}
    }
    expect([...applyRules(db, store, failing, [id(1, 2)]).handled]).toEqual([])
  })

  it('jedno pravidlo na požiadanie (aj vypnuté)', () => {
    const off = saveRule(db, { name: '', enabled: false, accountId: null, field: 'subject', value: 'obed', action: 'flag', folderId: null })
    const act = recorder()
    applyRules(db, store, act, store.listIds(1), [{ ...off, enabled: true }])
    expect(act.calls).toEqual([['flags', [id(1, 3)], { flagged: true }]])
  })
})

describe('šablóny', () => {
  it('uloží, prečistí HTML, rovnaký názov prepíše, odstráni', () => {
    expect(() => saveTemplate(db, { name: ' ', subject: '', html: null, text: '' })).toThrow(expect.objectContaining({ code: 'TEMPLATE_NAME' }))
    const a = saveTemplate(db, { name: 'Poďakovanie', subject: 'Ďakujem', html: '<p>Ďakujem <b>pekne</b><script>alert(1)</script></p>', text: '' })
    expect(a.html).not.toContain('script')
    expect(a.html).toContain('<b>pekne</b>')
    expect(a.text).toContain('Ďakujem')
    const b = saveTemplate(db, { name: 'poďakovanie', subject: 'Nové', html: null, text: 'Iba text' })
    expect(b.id).toBe(a.id)
    expect(listTemplates(db)).toEqual([{ id: a.id, name: 'poďakovanie', subject: 'Nové', html: null, text: 'Iba text' }])
    saveTemplate(db, { name: 'Adresa', subject: '', html: null, text: 'Hlavná 1' })
    expect(listTemplates(db).map((x) => x.name)).toEqual(['Adresa', 'poďakovanie'])
    deleteTemplate(db, a.id)
    expect(listTemplates(db).map((x) => x.name)).toEqual(['Adresa'])
  })
})

describe('úložisko: pomocné dotazy', () => {
  it('neprečítané v priečinku a riadok jednej správy', () => {
    expect(store.unreadIds(1).sort()).toEqual([id(1, 1), id(1, 2)].sort())
    // Spoločná doručená pošta = všetky kontá.
    expect(store.unreadIds(null)).toHaveLength(3)
    expect(store.messageItem(id(1, 3))).toMatchObject({ subject: 'Obed', seen: true, folderId: 1 })
    expect(store.messageItem(99_999)).toBeNull()
  })

  it('naplánovaná správa sa nepočíta medzi čakajúce zmeny, kým nepríde jej čas', () => {
    const later = new Date(Date.now() + 3_600_000).toISOString()
    const o = store.addOutbox({ accountId: 1, sha: 'a'.repeat(64), messageId: '<x@y>', subject: 'S', recipients: ['a@b.sk'], replyTo: null, saveCopy: false, sendAt: later })
    expect(store.countPendingChanges(1)).toBe(0)
    expect(store.outboxItems()[0]).toMatchObject({ id: o, sendAt: later, state: 'queued' })
    store.setOutboxSendAt(o, null)
    expect(store.countPendingChanges(1)).toBe(1)
  })
})
