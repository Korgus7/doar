import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/core/store/db'
import { MailStore } from '../../src/core/store/mailstore'
import {
  addFromMail,
  deleteContacts,
  listContacts,
  mailAddresses,
  mergeContacts,
  parseContactsFile,
  parseCsvContacts,
  parseVcards,
  saveContact,
  toCsv,
  toVcards
} from '../../src/core/contacts'

let db: Db
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'doar-contacts-')), 'doar.db'))
})

const empty = { name: '', email: '', phone: '', company: '', note: '', address: '' }

describe('adresár: uloženie, hľadanie, adresy z pošty', () => {
  it('pridá, upraví, nájde bez diakritiky, odmietne duplicitu a neplatnú adresu', () => {
    const a = saveContact(db, { ...empty, name: 'Ján Novák', email: 'jan@firma.sk', company: 'Firma s.r.o.' })
    saveContact(db, { ...empty, name: 'Eva Malá', email: 'eva@posta.sk' })
    expect(listContacts(db).map((c) => c.name)).toEqual(['Eva Malá', 'Ján Novák'])
    expect(listContacts(db, 'novak').map((c) => c.email)).toEqual(['jan@firma.sk'])
    expect(listContacts(db, 'FIRMA').map((c) => c.email)).toEqual(['jan@firma.sk'])
    expect(() => saveContact(db, { ...empty, email: 'JAN@firma.sk' })).toThrow(expect.objectContaining({ code: 'CONTACT_EXISTS' }))
    expect(() => saveContact(db, { ...empty, email: 'nie je adresa' })).toThrow(expect.objectContaining({ code: 'INVALID_EMAIL' }))
    const b = saveContact(db, { ...a, phone: '+421 900 123 456' })
    expect(b).toMatchObject({ id: a.id, phone: '+421 900 123 456' })
    deleteContacts(db, [a.id])
    expect(listContacts(db).map((c) => c.email)).toEqual(['eva@posta.sk'])
  })

  it('adresy z pošty: len adresáti odoslanej pošty, ktorí ešte nie sú v adresári; uloženie do adresára', () => {
    const store = new MailStore(db)
    store.rememberAddresses([{ name: 'Peter Kováč', address: 'Peter@Example.sk' }, { name: '', address: 'info@obchod.sk' }])
    saveContact(db, { ...empty, email: 'info@obchod.sk' })
    expect(mailAddresses(db).map((a) => a.email)).toEqual(['peter@example.sk'])
    expect(addFromMail(db, ['peter@example.sk', 'peter@example.sk'])).toEqual({ added: 1 })
    expect(listContacts(db, 'kovac')[0]).toMatchObject({ name: 'Peter Kováč', email: 'peter@example.sk' })
    expect(mailAddresses(db)).toEqual([])
    // Našepkávanie adries pri písaní: kontakty z adresára.
    saveContact(db, { ...empty, name: 'Zuzana Horská', email: 'zuzana@hory.sk' })
    expect(store.suggestAddresses('horsk', 5)).toEqual([{ name: 'Zuzana Horská', address: 'zuzana@hory.sk' }])
  })
})

describe('import vCard a CSV', () => {
  it('vCard 3.0: zložené riadky, escapovanie, viac adries (preferovaná prvá), N bez FN', () => {
    const v = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Mária Veľká',
      'EMAIL;TYPE=INTERNET,HOME:maria@doma.sk',
      'EMAIL;TYPE=INTERNET,WORK,PREF:maria.velka@pra',
      ' ca.sk',
      'TEL;TYPE=CELL:+421 900 000 001',
      'ORG:Veľká\\, Malá a spol.;Účtovníctvo',
      'NOTE:Prvý riadok\\nDruhý riadok',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Kráľ;Peter;;Ing.;',
      'EMAIL:mailto:peter@kral.sk',
      'END:VCARD'
    ].join('\r\n')
    expect(parseVcards(v)).toEqual([
      { name: 'Mária Veľká', emails: ['maria.velka@praca.sk', 'maria@doma.sk'], phone: '+421 900 000 001', company: 'Veľká, Malá a spol. Účtovníctvo', note: 'Prvý riadok\nDruhý riadok', address: '' },
      { name: 'Ing. Peter Kráľ', emails: ['peter@kral.sk'], phone: '', company: '', note: '', address: '' }
    ])
  })

  it('vCard 2.1 z Outlooku: quoted-printable vo Windows-1250 so zalomením', () => {
    // „Ľubomír Šťastný“ vo Windows-1250: Ľ=BC, í=ED, Š=8A, ť=9D, ý=FD
    const v = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=Windows-1250;ENCODING=QUOTED-PRINTABLE:=8A=9Dastn=FD;=BCubom=EDr',
      'FN;CHARSET=Windows-1250;ENCODING=QUOTED-PRINTABLE:=BCubom=EDr =8A=9Dastn=FD',
      'NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=utf-8:Dlh=C3=A1 pozn=C3=A1mka, ktor=C3=A1 pokra=C4=8Duje =',
      'na =C4=8Fal=C5=A1om riadku',
      'EMAIL;PREF;INTERNET:lubo@stastny.sk',
      'END:VCARD'
    ].join('\r\n')
    expect(parseVcards(v)).toEqual([{ name: 'Ľubomír Šťastný', emails: ['lubo@stastny.sk'], phone: '', company: '', note: 'Dlhá poznámka, ktorá pokračuje na ďalšom riadku', address: '' }])
  })

  it('CSV z Outlooku (anglický, čiarky) a zo slovenského Outlooku (bodkočiarky, Windows-1250)', () => {
    const en = [
      'First Name,Middle Name,Last Name,Company,E-mail Address,E-mail Type,E-mail Display Name,E-mail 2 Address,Mobile Phone,Business Phone,Notes',
      'Ján,,Novák,"Firma, s.r.o.",jan@firma.sk,SMTP,Ján Novák (jan@firma.sk),jan.novak@gmail.com,0900 111 222,02 123,"Poznámka ""v úvodzovkách""',
      'na dva riadky"',
      'Bez,,Adresy,,,,,,0900,,'
    ].join('\r\n')
    expect(parseCsvContacts(en)).toEqual([
      { name: 'Ján Novák', emails: ['jan@firma.sk', 'jan.novak@gmail.com'], phone: '0900 111 222, 02 123', company: 'Firma, s.r.o.', note: 'Poznámka "v úvodzovkách"\r\nna dva riadky', address: '' },
      { name: 'Bez Adresy', emails: [], phone: '0900', company: '', note: '', address: '' }
    ])
    // Slovenský Outlook: Windows-1250 a bodkočiarka (Excel).
    const cp1250: Record<string, number> = { 'ť': 0x9d, 'á': 0xe1, 'ý': 0xfd, 'ň': 0xf2, 'Ž': 0x8e, 'Č': 0xc8, 'Ú': 0xda, 'č': 0xe8, 'í': 0xed }
    const text = 'Meno;Priezvisko;E-mailová adresa;Mobilný telefón;Spoločnosť\r\nŽofia;Čierna;zofia@cierna.sk;0905 000 000;Účtovníctvo\r\n'
    const bytes = Buffer.from([...text].map((ch) => cp1250[ch] ?? ch.charCodeAt(0)))
    expect(parseContactsFile('kontakty.csv', bytes)).toEqual([{ name: 'Žofia Čierna', emails: ['zofia@cierna.sk'], phone: '0905 000 000', company: 'Účtovníctvo', note: '', address: '' }])
  })

  it('CSV z Gmailu a CSV s neznámymi hlavičkami (e-mail v ľubovoľnom stĺpci)', () => {
    const g = 'Name,Given Name,Family Name,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Type,Phone 1 - Value,Organization 1 - Name\nAnna Biela,Anna,Biela,* Home,anna@biela.sk ::: anna2@biela.sk,Mobile,+421 911,Škola\n'
    expect(parseCsvContacts(g)).toEqual([{ name: 'Anna Biela', emails: ['anna@biela.sk', 'anna2@biela.sk'], phone: '+421 911', company: 'Škola', note: '', address: '' }])
    expect(parseCsvContacts('Kto;Kam\nFero;fero@x.sk\n')).toEqual([{ name: '', emails: ['fero@x.sk'], phone: '', company: '', note: '', address: '' }])
  })

  it('poštová adresa: vCard ADR, CSV z Outlooku (domov pred prácou), z Gmailu a so slovenskými hlavičkami', () => {
    const v = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ján\r\nEMAIL:jan@a.sk\r\nADR;TYPE=HOME:;Byt 4;Hlavná 12;Pezinok;;902 01;Slovensko\r\nADR;TYPE=WORK:;;Iná 1;Senec;;903 01;\r\nEND:VCARD\r\n'
    expect(parseVcards(v)[0]!.address).toBe('Hlavná 12\nByt 4\n902 01 Pezinok\nSlovensko')
    const outlook = 'First Name,E-mail Address,Business Street,Business City,Business Postal Code,Home Street,Home City,Home Postal Code,Home Country/Region\nEva,eva@b.sk,,,,"Lipová 3\nposch. 2",Trnava,917 01,Slovensko\nIgor,igor@c.sk,Pracovná 5,Nitra,949 01,,,,\n'
    expect(parseCsvContacts(outlook).map((c) => c.address)).toEqual(['Lipová 3\nposch. 2\n917 01 Trnava\nSlovensko', 'Pracovná 5\n949 01 Nitra'])
    const google = 'Name,E-mail 1 - Value,Address 1 - Formatted,Address 1 - Street,Address 1 - City\nAnna,anna@d.sk,"Dlhá 7\n811 04 Bratislava",Dlhá 7,Bratislava\n'
    expect(parseCsvContacts(google)[0]!.address).toBe('Dlhá 7\n811 04 Bratislava')
    const sk = 'Meno;E-mailová adresa;Ulica (domov);Mesto (domov);PSČ (domov);Krajina/oblasť (domov)\nFero;fero@e.sk;Krátka 1;Modra;900 01;Slovensko\n'
    expect(parseCsvContacts(sk)[0]!.address).toBe('Krátka 1\n900 01 Modra\nSlovensko')
  })

  it('zlúčenie: nové pridá, existujúcemu len doplní prázdne polia, bez adresy preskočí', () => {
    saveContact(db, { ...empty, name: 'Moje meno', email: 'jan@firma.sk' })
    const r = mergeContacts(db, [
      { name: 'Ján Novák', emails: ['JAN@firma.sk', 'jan.novak@gmail.com'], phone: '0900', company: 'Firma', note: '', address: '' },
      { name: 'Bez adresy', emails: [], phone: '0900', company: '', note: '', address: '' }
    ])
    expect(r).toEqual({ added: 1, updated: 1, skipped: 1 })
    expect(listContacts(db)).toMatchObject([
      { name: 'Ján Novák', email: 'jan.novak@gmail.com', phone: '0900' },
      { name: 'Moje meno', email: 'jan@firma.sk', phone: '0900', company: 'Firma' }
    ])
    // Druhý import toho istého nič nezmení.
    expect(mergeContacts(db, [{ name: 'Ján Novák', emails: ['jan@firma.sk'], phone: '0900', company: 'Firma', note: '', address: '' }])).toEqual({ added: 0, updated: 0, skipped: 0 })
  })
})

describe('export', () => {
  const list = [
    { id: 1, name: 'Ľudmila Dlhé-Priezviskové Meno Ktoré Presahuje Sedemdesiatpäť Bajtov Riadku', email: 'ludmila@example.sk', phone: '+421 2', company: 'A; B, C', note: 'Riadok 1\nRiadok 2', address: 'Hlavná 1\n811 01 Bratislava' },
    { id: 2, name: '', email: 'bezmena@example.sk', phone: '', company: '', note: '', address: '' }
  ]

  it('vCard 3.0 sa načíta späť bez straty (zalomenie po 75 bajtoch, escapovanie)', () => {
    const v = toVcards(list)
    for (const line of v.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
    expect(parseContactsFile('x.vcf', Buffer.from(v))).toEqual([
      { name: list[0]!.name, emails: ['ludmila@example.sk'], phone: '+421 2', company: 'A; B, C', note: 'Riadok 1\nRiadok 2', address: 'Hlavná 1\n811 01 Bratislava' },
      { name: 'bezmena@example.sk', emails: ['bezmena@example.sk'], phone: '', company: '', note: '', address: '' }
    ])
  })

  it('CSV s hlavičkami Outlooku sa načíta späť', () => {
    const csv = toCsv(list)
    expect(csv.startsWith('﻿First Name,Last Name,E-mail Address')).toBe(true)
    expect(parseContactsFile('x.csv', Buffer.from(csv))).toEqual([
      { name: list[0]!.name, emails: ['ludmila@example.sk'], phone: '+421 2', company: 'A; B, C', note: 'Riadok 1\nRiadok 2', address: 'Hlavná 1\n811 01 Bratislava' },
      { name: '', emails: ['bezmena@example.sk'], phone: '', company: '', note: '', address: '' }
    ])
  })
})
