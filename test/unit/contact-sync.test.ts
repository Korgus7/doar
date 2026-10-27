import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/core/store/db'
import { ContactSync, patchVcard } from '../../src/core/contact-sync'
import { deleteContacts, listContacts, mergeContacts, saveContact } from '../../src/core/contacts'
import { parseMultistatus } from '../../src/core/carddav'
import { FakeCardDav } from '../fixtures/carddav-server'

let db: Db
let dav: FakeCardDav
let sync: ContactSync
let accountId: number
const events: string[] = []

const card = (lines: string[]): string => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n') + '\r\n'
const empty = { name: '', email: '', phone: '', company: '', note: '', address: '' }
const byEmail = (e: string) => listContacts(db).find((c) => c.email === e)
const serverCard = (email: string) => [...dav.cards.entries()].find(([, c]) => c.vcard.includes(`:${email}`))

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'doar-csync-')), 'doar.db'))
  accountId = Number(
    db
      .prepare(`INSERT INTO accounts (email, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, auth_type, username, provider_key) VALUES ('user@example.com','i',993,'tls','s',465,'tls','oauth2','user@example.com','gmail')`)
      .run().lastInsertRowid
  )
  dav = new FakeCardDav()
  await dav.start()
  sync = new ContactSync({ db, emit: (ch) => void events.push(ch), token: async () => dav.token, discoveryUrl: () => `${dav.base}/.well-known/carddav` })
})

afterEach(async () => {
  sync.stop()
  await dav.stop()
})

describe('synchronizácia adresára (CardDAV)', () => {
  it('prvá synchronizácia: prepojí podľa e-mailu, doplní, stiahne nové, nahrá miestne; údaje navyše na serveri ostanú', async () => {
    saveContact(db, { ...empty, name: 'Ján Novák', email: 'jan@firma.sk', phone: '0900 111 222' })
    saveContact(db, { ...empty, name: 'Len v Doare', email: 'doar@only.sk' })
    const janPath = dav.addCard(card(['UID:j1', 'FN:Jan Novak', 'N:Novak;Jan;;;', 'EMAIL;TYPE=INTERNET:jan@firma.sk', 'BDAY:1980-05-04', 'item1.X-ABLabel:Projekt']))
    dav.addCard(card(['UID:e1', 'FN:Eva Malá', 'item1.EMAIL;TYPE=INTERNET:eva@posta.sk', 'EMAIL:eva.mala@praca.sk', 'TEL;TYPE=CELL:+421 911', 'PHOTO;VALUE=URI:https://example.com/eva.jpg']))
    dav.addCard(card(['UID:t1', 'FN:Len telefón', 'TEL:+421 999']))

    expect(sync.status().candidates).toEqual([{ accountId, email: 'user@example.com' }])
    sync.enable(accountId)
    sync.stop()
    const r = await sync.syncNow()
    expect(r).toEqual({ downloaded: 3, uploaded: 2, removed: 0, onServer: 3, withoutEmail: 1 })

    // Ján: meno z Doaru ostalo, telefón z Doaru odišiel na server, narodeniny a štítok na serveri ostali.
    expect(byEmail('jan@firma.sk')).toMatchObject({ name: 'Ján Novák', phone: '0900 111 222' })
    const jan = dav.cards.get(janPath)!.vcard
    expect(jan).toContain('BDAY:1980-05-04')
    expect(jan).toContain('item1.X-ABLabel:Projekt')
    expect(jan).toContain('TEL:0900 111 222')
    expect(jan).toContain('UID:j1')
    // Eva: prvý e-mail, telefón; fotka ostáva len na serveri.
    expect(byEmail('eva@posta.sk')).toMatchObject({ name: 'Eva Malá', phone: '+421 911' })
    // Kontakt len s telefónom sa stiahol tiež; miestny sa nahral.
    expect(listContacts(db).map((c) => c.email).sort()).toEqual(['', 'doar@only.sk', 'eva@posta.sk', 'jan@firma.sk'])
    expect(listContacts(db, 'telefón')[0]).toMatchObject({ name: 'Len telefón', email: '', phone: '+421 999' })
    expect(serverCard('doar@only.sk')?.[1].vcard).toContain('FN:Len v Doare')
    expect(sync.status().enabled).toMatchObject({ email: 'user@example.com', lastError: null })
    expect(sync.status().localOnly).toBe(0)

    // Druhá synchronizácia bez zmien nič nerobí.
    expect(await sync.syncNow()).toMatchObject({ downloaded: 0, uploaded: 0, removed: 0, onServer: null })
  })

  it('kontakt bez e-mailu: zmena v Doare sa odošle bez pridania e-mailu, nový z Doaru sa nahrá', async () => {
    const t = dav.addCard(card(['UID:t', 'FN:Teta Mária', 'N:Mária;Teta;;;', 'TEL;TYPE=CELL:+421 905 000 001']))
    sync.enable(accountId)
    sync.stop()
    await sync.syncNow()
    const teta = listContacts(db, 'teta')[0]!
    saveContact(db, { ...teta, address: 'Dolná 5\n900 01 Modra' })
    saveContact(db, { ...empty, name: 'Strýko', phone: '0911 222 333' })
    expect(await sync.syncNow()).toMatchObject({ uploaded: 2 })
    const v = dav.cards.get(t)!.vcard
    expect(v).toContain('ADR;TYPE=HOME:;;Dolná 5\\n900 01 Modra;;;;')
    expect(v).not.toContain('EMAIL')
    expect(v).toContain('TEL;TYPE=CELL:+421 905 000 001')
    const strýko = [...dav.cards.values()].find((c) => c.vcard.includes('FN:Strýko'))!.vcard
    expect(strýko).toContain('TEL:0911 222 333')
    expect(strýko).not.toContain('EMAIL')
  })

  it('zmeny oboma smermi: z mobilu (úprava, zmazanie), z Doaru (úprava, zmazanie), súbežná zmena', async () => {
    const a = dav.addCard(card(['UID:a', 'FN:Anna Biela', 'EMAIL:anna@biela.sk', 'BDAY:1990-01-01']))
    const b = dav.addCard(card(['UID:b', 'FN:Boris Čierny', 'EMAIL:boris@cierny.sk']))
    const c = dav.addCard(card(['UID:c', 'FN:Cyril', 'EMAIL:cyril@x.sk']))
    sync.enable(accountId)
    sync.stop()
    await sync.syncNow()

    // Mobil: Anna zmenila meno, Boris zmazaný.
    dav.editCard(a, card(['UID:a', 'FN:Anna Biela-Nová', 'EMAIL:anna@biela.sk', 'BDAY:1990-01-01']))
    dav.deleteCard(b)
    expect(await sync.syncNow()).toMatchObject({ downloaded: 1, uploaded: 0, removed: 1 })
    expect(byEmail('anna@biela.sk')?.name).toBe('Anna Biela-Nová')
    expect(byEmail('boris@cierny.sk')).toBeUndefined()

    // Doar: poznámka a adresa k Anne, Cyril zmazaný.
    saveContact(db, { ...byEmail('anna@biela.sk')!, note: 'Volať večer', address: 'Hlavná 1\n811 01 Bratislava' })
    deleteContacts(db, [byEmail('cyril@x.sk')!.id])
    expect(await sync.syncNow()).toMatchObject({ downloaded: 0, uploaded: 2, removed: 0 })
    const anna = dav.cards.get(a)!.vcard
    expect(anna).toContain('NOTE:Volať večer')
    expect(anna).toContain('ADR;TYPE=HOME:;;Hlavná 1\\n811 01 Bratislava;;;;')
    expect(anna).toContain('BDAY:1990-01-01')
    expect(dav.cards.has(c)).toBe(false)

    // Súbežne: v mobile iné meno, v Doare telefón → obe zmeny ostanú.
    dav.editCard(a, dav.cards.get(a)!.vcard.replace('FN:Anna Biela-Nová', 'FN:Anna B.'))
    saveContact(db, { ...byEmail('anna@biela.sk')!, phone: '0905 000 000' })
    await sync.syncNow()
    const merged = dav.cards.get(a)!.vcard
    expect(merged).toContain('FN:Anna B.')
    expect(merged).toContain('TEL:0905 000 000')
    expect(byEmail('anna@biela.sk')).toMatchObject({ phone: '0905 000 000' })
    await sync.syncNow()
    expect(byEmail('anna@biela.sk')).toMatchObject({ name: 'Anna B.', phone: '0905 000 000', note: 'Volať večer' })
  })

  it('import do synchronizovaného adresára sa odošle; neplatný sync-token → celé načítanie znova', async () => {
    dav.addCard(card(['UID:a', 'FN:Anna', 'EMAIL:anna@a.sk']))
    sync.enable(accountId)
    sync.stop()
    await sync.syncNow()
    mergeContacts(db, [{ name: 'Anna', emails: ['anna@a.sk'], phone: '+421 1', company: 'Firma', note: '', address: '' }])
    dav.dropHistory()
    dav.addCard(card(['UID:z', 'FN:Zoja', 'EMAIL:zoja@z.sk']))
    const r = await sync.syncNow()
    expect(r.downloaded).toBe(1)
    expect(byEmail('zoja@z.sk')).toBeDefined()
    expect(serverCard('anna@a.sk')?.[1].vcard).toContain('ORG:Firma')
  })

  it('chýbajúce oprávnenie ku kontaktom: chyba CONTACTS_PERMISSION, stav si ju zapamätá; vypnutie zruší prepojenia', async () => {
    dav.addCard(card(['UID:a', 'FN:Anna', 'EMAIL:anna@a.sk']))
    sync.enable(accountId)
    sync.stop()
    dav.forbid = true
    await expect(sync.syncNow()).rejects.toMatchObject({ code: 'CONTACTS_PERMISSION' })
    expect(sync.status().enabled?.lastError).toBe('CONTACTS_PERMISSION')
    dav.forbid = false
    await sync.syncNow()
    expect(sync.status().enabled?.lastError).toBeNull()
    sync.disable()
    expect(sync.status().enabled).toBeNull()
    expect(sync.status().localOnly).toBe(1)
    expect(byEmail('anna@a.sk')).toBeDefined()
    expect(events).toContain('contacts.changed')
  })

  it('synchronizovať sa dá len s kontom Google prihláseným cez Google', () => {
    const pw = Number(
      db
        .prepare(`INSERT INTO accounts (email, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, username) VALUES ('p@x.sk','i',993,'tls','s',465,'tls','p@x.sk')`)
        .run().lastInsertRowid
    )
    expect(() => sync.enable(pw)).toThrow(expect.objectContaining({ code: 'CONTACTS_ACCOUNT' }))
  })
})

describe('úprava vCard a odpovede servera', () => {
  it('patchVcard prepíše len zmenené polia (skupiny a parametre ostanú)', () => {
    const raw = card(['UID:1', 'FN:Ján', 'N:;Ján;;;', 'item1.EMAIL;TYPE=INTERNET:jan@a.sk', 'TEL;TYPE=CELL:111', 'TEL;TYPE=WORK:222', 'BDAY:2000-01-01'])
    const out = patchVcard(raw, { name: 'Ján', email: 'jan@a.sk', phone: '111, 333', company: 'Firma; a.s.', note: '', address: '' })
    expect(out).toContain('FN:Ján\r\n')
    expect(out).toContain('item1.EMAIL;TYPE=INTERNET:jan@a.sk')
    expect(out).toContain('TEL;TYPE=CELL:111\r\nTEL;TYPE=WORK:333')
    expect(out).toContain('ORG:Firma\\; a.s.')
    expect(out).toContain('BDAY:2000-01-01')
    expect(out).toMatch(/REV:\d{4}-\d\d-\d\dT/)
    expect(out.trimEnd().endsWith('END:VCARD')).toBe(true)
  })

  it('multistatus: menné priestory s rôznymi predponami, CDATA, entity, stav 404, sync-token', () => {
    const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <response><href>/a.vcf</href><propstat><prop><getetag>"1"</getetag><C:address-data><![CDATA[BEGIN:VCARD
FN:A & B <x>
END:VCARD]]></C:address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>
      <response><href>/b%20c.vcf</href><propstat><prop><getetag>&quot;2&quot;</getetag><C:address-data>BEGIN:VCARD&#13;
FN:Č &amp; D
END:VCARD</C:address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>
      <response><href>/gone.vcf</href><status>HTTP/1.1 404 Not Found</status></response>
      <sync-token>http://x/sync/9</sync-token></multistatus>`
    const r = parseMultistatus(xml)
    expect(r.syncToken).toBe('http://x/sync/9')
    expect(r.responses.map((x) => [x.href, x.status])).toEqual([['/a.vcf', null], ['/b%20c.vcf', null], ['/gone.vcf', 404]])
    expect(r.responses[0]!.props).toContain('FN:A & B <x>')
  })
})
