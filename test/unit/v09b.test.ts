import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleParser } from 'mailparser'
import { openDb, type Db } from '../../src/core/store/db'
import { listAccounts, reorderAccounts, updateAccount } from '../../src/core/accounts'
import { deleteSignature, listSignatures, readSignatureImage, saveSignature, setDefaultSignature } from '../../src/core/signatures'
import { deleteGroup, groupAddresses, listContactsWithGroups, listGroups, saveContact, saveGroup, setGroupMembers, suggestGroups } from '../../src/core/contacts'
import { inlineImages, outgoingHtml, sanitizeComposeHtml } from '../../src/core/mail/outgoing-html'
import { composeMessage } from '../../src/core/mail/compose'
import { FileGrants } from '../../src/core/files'
import { previewKind } from '../../src/shared/ipc'

/** Verzia 0.9 (druhá časť): podpisy s logom, skupiny v adresári, náhľad príloh. */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
let db: Db

beforeEach(() => {
  db = openDb(':memory:')
  db.prepare(`INSERT INTO accounts(id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username)
    VALUES (1,'ja@doar.test','imap',993,'tls','smtp',465,'tls','ja'), (2,'druhe@doar.test','imap',993,'tls','smtp',465,'tls','d')`).run()
})

describe('podpisy', () => {
  it('prvý podpis je predvolený; viac podpisov; predvolený ako text pre čistý text; žiadny predvolený', () => {
    const a = saveSignature(db, { accountId: 1, name: 'Pracovný', html: '<p>Ján Novák<br><b>Firma s.r.o.</b></p>' })
    expect(a).toMatchObject({ isDefault: true, text: 'Ján Novák\nFirma s.r.o.' })
    const b = saveSignature(db, { accountId: 1, name: 'Krátky', html: '<p>J. N.</p><script>alert(1)</script>' })
    expect(b.isDefault).toBe(false)
    expect(b.html).not.toContain('script')
    const acc = listAccounts(db).find((x) => x.id === 1)!
    expect(acc.signatures.map((s) => s.name)).toEqual(['Pracovný', 'Krátky'])
    expect(acc.signature).toBe('Ján Novák\nFirma s.r.o.')
    setDefaultSignature(db, 1, b.id)
    expect(listAccounts(db)[0]!.signature).toBe('J. N.')
    setDefaultSignature(db, 1, null)
    expect(listAccounts(db)[0]!.signature).toBe('')
    expect(() => setDefaultSignature(db, 2, a.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => saveSignature(db, { accountId: 1, name: '', html: '<p> </p>' })).toThrow(expect.objectContaining({ code: 'SIGNATURE_EMPTY' }))
    deleteSignature(db, a.id)
    expect(listSignatures(db, 1).map((s) => s.name)).toEqual(['Krátky'])
  })

  it('logo: len vložený obrázok (data:), odkaz na internet sa zahodí', () => {
    const html = sanitizeComposeHtml(`<p>Ján<br><img src="data:image/png;base64,${PNG}" width="120" onerror="x()"><img src="https://tracker.example/x.png"></p>`)
    expect(html).toContain(`<img src="data:image/png;base64,${PNG}" width="120" />`)
    expect(html).not.toContain('tracker')
    expect(html).not.toContain('onerror')
    // Samotné logo bez textu je platný podpis.
    expect(saveSignature(db, { accountId: 2, name: '', html: `<p><img src="data:image/png;base64,${PNG}"></p>` }).html).toContain('<img')
  })

  it('textový podpis zo starších nastavení konta → predvolený podpis', () => {
    updateAccount(db, 1, { signature: 'Ján\n<Firma>' })
    expect(listSignatures(db, 1)).toEqual([expect.objectContaining({ html: '<p>Ján<br />&lt;Firma&gt;</p>', isDefault: true })])
    updateAccount(db, 1, { signature: '' })
    expect(listSignatures(db, 1)).toEqual([])
  })

  it('migrácia prenesie doterajší textový podpis', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'doar-sig-')), 'doar.db')
    const old = openDb(file)
    old.prepare(`INSERT INTO accounts(id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,signature)
      VALUES (1,'a@b.sk','i',993,'tls','s',465,'tls','a','Ján Novák\r\nTel. 0905 <1>')`).run()
    // Databáza z verzie 0.8 (migrácie po 17 sa vrátia).
    old.exec('DELETE FROM schema_migrations WHERE version = 19; DROP INDEX messages_remote; ALTER TABLE messages DROP COLUMN remote_id; ALTER TABLE folders DROP COLUMN delta_link; ALTER TABLE accounts DROP COLUMN protocol')
    old.exec("DELETE FROM signatures; DELETE FROM schema_migrations WHERE version = 18; DROP TABLE signatures; DROP TABLE contact_group_members; DROP TABLE contact_groups; DROP INDEX messages_thread; DROP INDEX messages_account_msgid; DROP INDEX messages_reply_to; DROP INDEX messages_thread_subject; ALTER TABLE messages DROP COLUMN thread_subject")
    old.close()
    const db2 = openDb(file)
    expect(listSignatures(db2, 1)).toEqual([expect.objectContaining({ html: '<p>Ján Novák<br>Tel. 0905 &lt;1&gt;</p>', text: 'Ján Novák\nTel. 0905 <1>', isDefault: true })])
    db2.close()
  })

  it('logo v odoslanej správe ide ako príloha s Content-ID (multipart/related)', async () => {
    const out = inlineImages(outgoingHtml(`<p>Text</p><p>--</p><p>Ján<br><img src="data:image/png;base64,${PNG}"><img src="data:image/png;base64,${PNG}"></p>`), 'doar.test')
    expect(out.images).toHaveLength(1)
    expect(out.html).toMatch(/<img src="cid:obrazok1\.[a-z0-9]+@doar\.test" \/>/)
    const { raw } = await composeMessage({
      from: { name: 'Ja', address: 'ja@doar.test' },
      to: [{ name: '', address: 'eva@doar.test' }],
      cc: [],
      bcc: [],
      subject: 'S logom',
      text: 'Text',
      html: out.html,
      attachments: out.images
    })
    expect(raw.toString()).toMatch(/multipart\/related/)
    const p = await simpleParser(raw)
    expect(p.attachments).toEqual([expect.objectContaining({ contentType: 'image/png', related: true })])
  })

  it('logo zo súboru: len obrázok vybraný v dialógu, najviac 500 kB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doar-logo-'))
    const files = new FileGrants()
    const png = join(dir, 'logo.png')
    writeFileSync(png, Buffer.from(PNG, 'base64'))
    await expect(readSignatureImage(files, png)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    files.allow(png, 'read')
    expect((await readSignatureImage(files, png)).dataUrl).toBe(`data:image/png;base64,${PNG}`)
    const svg = join(dir, 'logo.svg')
    writeFileSync(svg, '<svg/>')
    files.allow(svg, 'read')
    await expect(readSignatureImage(files, svg)).rejects.toMatchObject({ code: 'IMAGE_TYPE' })
    const big = join(dir, 'velke.jpg')
    writeFileSync(big, Buffer.alloc(600 * 1024))
    files.allow(big, 'read')
    await expect(readSignatureImage(files, big)).rejects.toMatchObject({ code: 'IMAGE_TOO_BIG' })
  })
})

describe('skupiny v adresári', () => {
  it('skupina, členovia, adresy, našepkávanie bez diakritiky, odstránenie bez straty kontaktov', () => {
    const mama = saveContact(db, { name: 'Mama', email: 'mama@doma.sk', phone: '', company: '', note: '', address: '' })
    const ocko = saveContact(db, { name: 'Ocko', email: 'ocko@doma.sk', phone: '', company: '', note: '', address: '' })
    const babka = saveContact(db, { name: 'Babka', email: '', phone: '0905 111 222', company: '', note: '', address: '' })
    const g = saveGroup(db, { name: '  Rodina   blízka ' })
    expect(g).toMatchObject({ name: 'Rodina blízka', count: 0 })
    expect(() => saveGroup(db, { name: 'rodina BLÍZKA' })).toThrow(expect.objectContaining({ code: 'GROUP_EXISTS' }))
    expect(() => saveGroup(db, { name: ' ' })).toThrow(expect.objectContaining({ code: 'GROUP_NAME' }))
    setGroupMembers(db, g.id, { add: [mama.id, ocko.id, babka.id, 9999] })
    expect(listGroups(db)).toEqual([{ id: g.id, name: 'Rodina blízka', count: 3, withEmail: 2 }])
    expect(groupAddresses(db, g.id)).toEqual([
      { name: 'Mama', address: 'mama@doma.sk' },
      { name: 'Ocko', address: 'ocko@doma.sk' }
    ])
    expect(listContactsWithGroups(db, '', g.id).map((c) => c.name)).toEqual(['Babka', 'Mama', 'Ocko'])
    expect(suggestGroups(db, 'bliz')).toEqual([{ id: g.id, name: 'Rodina blízka', members: groupAddresses(db, g.id) }])
    expect(suggestGroups(db, 'mam')).toEqual([])
    // Uloženie kontaktu so zoznamom skupín.
    const other = saveGroup(db, { name: 'Práca' })
    expect(saveContact(db, { ...ocko, groups: [other.id] }).groups).toEqual([other.id])
    expect(listGroups(db).find((x) => x.id === g.id)!.count).toBe(2)
    setGroupMembers(db, g.id, { remove: [babka.id] })
    expect(listContactsWithGroups(db, '', g.id).map((c) => c.name)).toEqual(['Mama'])
    deleteGroup(db, g.id)
    expect(listContactsWithGroups(db).map((c) => c.name)).toEqual(['Babka', 'Mama', 'Ocko'])
  })
})

describe('náhľad príloh', () => {
  it('druh náhľadu podľa typu a prípony', () => {
    expect(previewKind('foto.JPG', 'application/octet-stream')).toBe('image')
    expect(previewKind('x', 'image/png')).toBe('image')
    expect(previewKind('kresba.svg', 'image/svg+xml')).toBeNull()
    expect(previewKind('zmluva.pdf', 'application/octet-stream')).toBe('pdf')
    expect(previewKind('poznamky.txt', '')).toBe('text')
    expect(previewKind('program.exe', 'application/x-msdownload')).toBeNull()
  })
})

describe('poradie kont', () => {
  it('nové poradie platí pre zoznam; neúplný alebo cudzí zoznam sa odmietne', () => {
    db.prepare(`INSERT INTO accounts(id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username)
      VALUES (3,'tretie@doar.test','imap',993,'tls','smtp',465,'tls','t')`).run()
    expect(listAccounts(db).map((a) => a.id)).toEqual([1, 2, 3])
    reorderAccounts(db, [3, 1, 2])
    expect(listAccounts(db).map((a) => a.id)).toEqual([3, 1, 2])
    for (const bad of [[3, 1], [3, 1, 1], [3, 1, 9], 'x', null]) {
      expect(() => reorderAccounts(db, bad)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    }
    expect(listAccounts(db).map((a) => a.id)).toEqual([3, 1, 2])
  })
})

describe('farba písma a pozadia', () => {
  it('ponechá len color a background-color v tvare #rrggbb na span', () => {
    const h = '<p>a <span style="color:#b42318">červené</span> <span style="color:red;background:url(x)">x</span> <span style="position:fixed">y</span></p>'
    expect(sanitizeComposeHtml(h)).toBe('<p>a <span style="color:#b42318">červené</span> <span>x</span> <span>y</span></p>')
    expect(outgoingHtml(h)).toContain('<span style="color:#b42318">červené</span>')
    expect(outgoingHtml(h)).not.toMatch(/url\(|position|color:red/)
    // Prehliadač (editor) zapisuje farbu ako rgb(…).
    expect(sanitizeComposeHtml('<p><span style="color: rgb(180, 35, 24);">D</span></p>')).toBe('<p><span style="color:#b42318">D</span></p>')
    // Farba pozadia (zvýraznenie), aj spolu s farbou písma; iné vlastnosti preč.
    expect(sanitizeComposeHtml('<p><span style="background-color: rgb(242, 196, 15); font-size: 40px">Z</span></p>')).toBe('<p><span style="background-color:#f2c40f">Z</span></p>')
    expect(outgoingHtml('<p><span style="color:#000000;background-color:#ffffff;background:url(x)">B</span></p>')).toContain('<span style="color:#000000;background-color:#ffffff">B</span>')
  })
})

describe('pozadie celej správy', () => {
  it('obal z editora prejde čistením, pri odoslaní je farba na celej správe a koncept si ju zachová', () => {
    const fromEditor = '<div data-doar-bg="#FFF6CC"><p>Ahoj <span style="color:#e31e24">svet</span></p></div>'
    expect(sanitizeComposeHtml(fromEditor)).toBe('<div data-doar-bg="#fff6cc"><p>Ahoj <span style="color:#e31e24">svet</span></p></div>')
    const out = outgoingHtml(fromEditor)
    expect(out).toContain('<body style="margin:0;background-color:#fff6cc">')
    expect(out).toContain('<div data-doar-bg="#fff6cc" style="background-color:#fff6cc;')
    // Koncept zo servera (celá odoslaná podoba) → editor dostane ten istý obal.
    expect(sanitizeComposeHtml(out)).toBe('<div data-doar-bg="#fff6cc"><p>Ahoj <span style="color:#e31e24">svet</span></p></div>')
    // Bez pozadia sa nič nemení; obal v citovanej správe (nie na začiatku) sa nepoužije; neplatná farba nie.
    expect(outgoingHtml('<p>x</p>')).toContain('<body><div style="font-family')
    expect(sanitizeComposeHtml('<p>a</p><blockquote><div data-doar-bg="#000000"><p>b</p></div></blockquote>')).toBe('<p>a</p><blockquote><p>b</p></blockquote>')
    expect(sanitizeComposeHtml('<div data-doar-bg="red"><p>c</p></div>')).toBe('<p>c</p>')
  })
})
