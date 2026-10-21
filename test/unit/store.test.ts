import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb, schemaVersion, MIGRATIONS } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doar-unit-'))
})

describe('databáza a migrácie', () => {
  it('nová databáza dostane najnovšiu verziu schémy', () => {
    const db = openDb(join(dir, 'doar.db'))
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version)
    db.close()
  })

  it('opakované otvorenie nič nemení a nevytvorí zbytočnú zálohu', () => {
    openDb(join(dir, 'doar.db')).close()
    const db = openDb(join(dir, 'doar.db'))
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version)
    db.close()
    expect(readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(false)
  })

  it('aktualizácia staršej databázy: zálohuje ju a zachová údaje', () => {
    // Databáza vo verzii 1 s jedným kontom (ako po inštalácii staršej verzie).
    const file = join(dir, 'doar.db')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT '')`)
    old.exec(MIGRATIONS[0]!.sql)
    old.prepare('INSERT INTO schema_migrations(version, name) VALUES (1, ?)').run('init')
    old.prepare(`INSERT INTO accounts(email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username)
      VALUES ('a@b.sk','imap.b.sk',993,'tls','smtp.b.sk',465,'tls','a@b.sk')`).run()
    old.close()

    const db = openDb(file)
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version)
    const acc = db.prepare('SELECT email, password_storage FROM accounts').get() as { email: string; password_storage: string }
    expect(acc).toEqual({ email: 'a@b.sk', password_storage: 'os' })
    db.close()
    expect(existsSync(`${file}.bak-v1`)).toBe(true)
  })

  it('odmietne databázu z novšej verzie aplikácie', () => {
    const db = openDb(join(dir, 'doar.db'))
    db.prepare('INSERT INTO schema_migrations(version, name) VALUES (999, ?)').run('future')
    db.close()
    expect(() => openDb(join(dir, 'doar.db'))).toThrow(/DB_TOO_NEW/)
  })

  it('fulltext nájde slovo bez diakritiky a bez ohľadu na veľkosť písmen', () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO messages_fts(rowid, subject, from_text, to_text, body_text) VALUES (1, ?, ?, ?, ?)').run(
      'Faktúra za OKTÓBER',
      'Ján Novák <jan@firma.sk>',
      'eva@mail.sk',
      'Dobrý deň, posielam vyúčtovanie.'
    )
    const hit = (q: string) => db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(q).length
    expect(hit('faktura')).toBe(1)
    expect(hit('oktober')).toBe(1)
    expect(hit('vyuctovanie')).toBe(1)
    expect(hit('novak')).toBe(1)
    expect(hit('neexistuje')).toBe(0)
    db.close()
  })

  it('cudzie kľúče: zmazanie konta zmaže jeho priečinky a správy v lokálnej DB', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO accounts(id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username)
      VALUES (1,'a@b.sk','imap.b.sk',993,'tls','smtp.b.sk',465,'tls','a@b.sk')`).run()
    db.prepare(`INSERT INTO folders(id,account_id,path,name) VALUES (1,1,'INBOX','INBOX')`).run()
    db.prepare(`INSERT INTO messages(account_id,folder_id,uid) VALUES (1,1,10)`).run()
    db.prepare('DELETE FROM accounts WHERE id = 1').run()
    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(0)
    db.close()
  })
})

describe('úložisko originálov', () => {
  it('uloží správu pod jej SHA-256 a vráti presne tie isté bajty', () => {
    const blobs = new BlobStore(join(dir, 'blobs'))
    const raw = Buffer.from('From: a@b.sk\r\nSubject: =?UTF-8?Q?Fakt=C3=BAra?=\r\n\r\nTelo\r\n')
    const sha = blobs.put(raw)
    expect(sha).toBe(BlobStore.hash(raw))
    expect(blobs.read(sha).equals(raw)).toBe(true)
    expect(blobs.verify(sha)).toBe(true)
    expect(blobs.put(raw)).toBe(sha) // duplicita = ten istý súbor
    const leftovers = readdirSync(join(dir, 'blobs', sha.slice(0, 2), sha.slice(2, 4)))
    expect(leftovers).toEqual([`${sha}.eml`]) // žiadne .tmp
  })

  it('odhalí poškodený súbor', () => {
    const blobs = new BlobStore(join(dir, 'blobs'))
    const sha = blobs.put(Buffer.from('original'))
    writeFileSync(blobs.pathOf(sha), 'zmenené')
    expect(blobs.verify(sha)).toBe(false)
  })

  it('odmietne neplatný identifikátor (ochrana pred ../)', () => {
    const blobs = new BlobStore(join(dir, 'blobs'))
    expect(() => blobs.pathOf('../../etc/passwd')).toThrow('INVALID_BLOB_ID')
    expect(existsSync(join(dir, 'blobs'))).toBe(true)
  })
})
