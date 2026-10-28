import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleParser } from 'mailparser'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { FileGrants } from '../../src/core/files'
import { ArchiveManager } from '../../src/core/archive/archive'
import { unsubscribeInfo, unsubscribeOf } from '../../src/core/mail/parse'
import { unsubscribe, type UnsubscribeFetch } from '../../src/core/unsubscribe'
import { buildView } from '../../src/core/view'
import type { Ctx } from '../../src/core/compose-service'
import type { SyncManager } from '../../src/core/sync/manager'
import { EML_ID_BASE, isArchiveId, isEmlId } from '../../src/shared/ipc'

let dir: string
let db: Db
let blobs: BlobStore
let store: MailStore
let ctx: Ctx

function mail(headers: string): Buffer {
  return Buffer.from(`From: Obchod <novinky@obchod.sk>\r\nTo: ja@doar.test\r\nSubject: Akcia\r\nMessage-ID: <n1@obchod.sk>\r\n${headers}Content-Type: text/plain; charset=utf-8\r\n\r\nNovinky\r\n`)
}

/** Správa v doručenej pošte konta 1 s daným originálom. */
function addMessage(raw: Buffer): number {
  const sha = blobs.put(raw)
  return (db.prepare(`INSERT INTO messages(account_id, folder_id, uid, blob_sha256, subject, from_addr) VALUES (1, 1, ?, ?, 'Akcia', 'novinky@obchod.sk') RETURNING id`).get(Math.floor(Math.random() * 1e6), sha) as { id: number }).id
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doar-extras-'))
  db = openDb(':memory:')
  blobs = new BlobStore(join(dir, 'blobs'))
  store = new MailStore(db)
  db.prepare(`INSERT INTO accounts(id,email,display_name,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username)
    VALUES (1,'ja@doar.test','Ja','imap',993,'tls','smtp',465,'tls','ja')`).run()
  db.prepare(`INSERT INTO folders(id,account_id,path,name,special_use) VALUES (1,1,'INBOX','INBOX','inbox')`).run()
  ctx = { db, blobs, store, sync: { get: () => undefined } as unknown as SyncManager, emit: () => {} }
})

describe('odhlásenie z odberu: hlavičky', () => {
  it('rozpozná jeden klik (len https), mailto a stránku', async () => {
    const both = await unsubscribeOf(
      mail('List-Unsubscribe: <mailto:off@obchod.sk?subject=stop>,\r\n <https://obchod.sk/off?u=1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n')
    )
    expect(both).toEqual({ oneClick: 'https://obchod.sk/off?u=1', mailto: 'mailto:off@obchod.sk?subject=stop', url: 'https://obchod.sk/off?u=1' })
    // http nie je jeden klik (RFC 8058 vyžaduje https) – len stránka.
    expect(await unsubscribeOf(mail('List-Unsubscribe: <http://obchod.sk/off>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n'))).toEqual({
      oneClick: null,
      mailto: null,
      url: 'http://obchod.sk/off'
    })
    expect(await unsubscribeOf(mail(''))).toBeNull()
    // Iné schémy (javascript:, ftp:) sa ignorujú.
    expect(await unsubscribeOf(mail('List-Unsubscribe: <javascript:alert(1)>, <ftp://x>\r\n'))).toBeNull()
    expect(unsubscribeInfo(await simpleParser(mail('List-Unsubscribe: <mailto:off@obchod.sk>\r\n')))).toEqual({ oneClick: null, mailto: 'mailto:off@obchod.sk', url: null })
  })

  it('zobrazenie správy hovorí, ktorý spôsob sa použije', async () => {
    const base = { id: 1, accountId: 1, subject: '', date: null, sender: '' }
    expect((await buildView({ db }, mail('List-Unsubscribe: <mailto:off@obchod.sk>\r\n'), base)).unsubscribe).toBe('mailto')
    expect((await buildView({ db }, mail('List-Unsubscribe: <https://x.sk/o>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n'), base)).unsubscribe).toBe('oneClick')
    expect((await buildView({ db }, mail('List-Unsubscribe: <https://x.sk/o>\r\n'), base)).unsubscribe).toBe('url')
    expect((await buildView({ db }, mail(''), base)).unsubscribe).toBeNull()
  })
})

describe('odhlásenie z odberu: vykonanie', () => {
  it('jeden klik: POST „List-Unsubscribe=One-Click“ na adresu odosielateľa', async () => {
    const id = addMessage(mail('List-Unsubscribe: <https://obchod.sk/off?u=1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n'))
    const calls: { url: string; method: string; body: string }[] = []
    const fetchFn: UnsubscribeFetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body })
      return new Response('', { status: 200 })
    }
    expect(await unsubscribe(ctx, id, fetchFn)).toEqual({ done: 'oneClick' })
    expect(calls).toEqual([{ url: 'https://obchod.sk/off?u=1', method: 'POST', body: 'List-Unsubscribe=One-Click' }])
  })

  it('odmietnutý jeden klik → e‑mail na mailto adresu; adresa sa nepridá do našepkávania', async () => {
    const id = addMessage(
      mail('List-Unsubscribe: <https://obchod.sk/off>, <mailto:off@obchod.sk?subject=Odhl%C3%A1si%C5%A5>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n')
    )
    const r = await unsubscribe(ctx, id, async () => new Response('', { status: 500 }))
    expect(r).toEqual({ done: 'mailto' })
    const out = store.outboxItems()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ subject: 'Odhlásiť', recipients: ['off@obchod.sk'], state: 'queued', sendAt: null })
    expect(db.prepare('SELECT COUNT(*) AS c FROM addresses').get()).toEqual({ c: 0 })
  })

  it('len stránka → otvorí ju rozhranie; bez hlavičky → chyba', async () => {
    expect(await unsubscribe(ctx, addMessage(mail('List-Unsubscribe: <https://obchod.sk/off>\r\n')), async () => new Response(''))).toEqual({
      open: 'https://obchod.sk/off'
    })
    await expect(unsubscribe(ctx, addMessage(mail('')))).rejects.toMatchObject({ code: 'NO_UNSUBSCRIBE' })
  })
})

describe('správa zo súboru .eml', () => {
  it('otvorí len povolený súbor, ten istý súbor dostane to isté ID, správa sa dá zobraziť', async () => {
    const files = new FileGrants()
    const archives = new ArchiveManager({ db, files, emit: () => {} })
    const path = join(dir, 'sprava.eml')
    writeFileSync(path, mail('List-Unsubscribe: <mailto:off@obchod.sk>\r\n'))
    await expect(archives.openEml(path)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    files.allow(path, 'read')
    const { id } = await archives.openEml(path)
    expect(id).toBe(EML_ID_BASE)
    expect(isEmlId(id) && isArchiveId(id)).toBe(true)
    expect(isEmlId(-5)).toBe(false)
    expect((await archives.openEml(path)).id).toBe(id)
    const view = await archives.view(id, {})
    expect(view).toMatchObject({ id, subject: 'Akcia', from: [{ name: 'Obchod', address: 'novinky@obchod.sk' }] })
    expect((await archives.raw(id)).toString()).toContain('Novinky')
    expect(archives.meta(id)).toEqual({ source: null, date: null })

    const junk = join(dir, 'obrazok.eml')
    writeFileSync(junk, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]))
    files.allow(junk, 'read')
    await expect(archives.openEml(junk)).rejects.toMatchObject({ code: 'NOT_EML' })
  })
})

describe('náhľad prílohy', () => {
  it('obrázok ako data:, text v UTF-8 aj Windows-1250, PDF ako dočasná kópia, iné nie', async () => {
    const { previewAttachment } = await import('../../src/core/attachments')
    const part = (name: string, type: string, data: Buffer): string =>
      `--b\r\nContent-Type: ${type}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${data.toString('base64')}\r\n`
    const raw = Buffer.from(
      `From: a@b.sk\r\nTo: ja@doar.test\r\nSubject: P\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nx\r\n` +
        part('a.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64')) +
        part('u.txt', 'text/plain', Buffer.from('Žluťoučký kůň')) +
        part('w.txt', 'text/plain', Buffer.from([0x8e, 0x6c, 0x75, 0x9d])) +
        part('z.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n')) +
        part('fake.pdf', 'application/pdf', Buffer.from('MZ program')) +
        part('k.svg', 'image/svg+xml', Buffer.from('<svg onload="x()"/>')) +
        '--b--\r\n'
    )
    const id = addMessage(raw)
    const c = { ...ctx, files: new FileGrants(), dataDir: dir }
    expect(await previewAttachment(c, id, 0)).toEqual({ kind: 'image', dataUrl: expect.stringMatching(/^data:image\/png;base64,iVBOR/) })
    expect(await previewAttachment(c, id, 1)).toEqual({ kind: 'text', text: 'Žluťoučký kůň' })
    expect(await previewAttachment(c, id, 2)).toEqual({ kind: 'text', text: 'Žluť' })
    const pdf = await previewAttachment(c, id, 3)
    expect(pdf).toMatchObject({ kind: 'pdf', path: expect.stringMatching(/z\.pdf$/) })
    await expect(previewAttachment(c, id, 4)).rejects.toMatchObject({ code: 'NO_PREVIEW' })
    await expect(previewAttachment(c, id, 5)).rejects.toMatchObject({ code: 'NO_PREVIEW' })
  })
})
