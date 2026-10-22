import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'

const srv = inject('testserver')
const USER = 'jozef@doar.test'
const DELAY = 400

let db: Db
let store: MailStore
let sync: SyncManager
let accountId: number
let other: ImapFlow

const msg = (subject: string) => Buffer.from(`From: Jan <jan@firma.sk>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@firma.sk>\r\n\r\nText ${subject}\r\n`)

async function until(fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('časový limit')
}

async function serverSubjects(path: string): Promise<string[]> {
  const lock = await other.getMailboxLock(path)
  try {
    await other.noop()
    if (!other.mailbox || !other.mailbox.exists) return []
    const out: string[] = []
    for await (const m of other.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '')
    return out.sort()
  } finally {
    lock.release()
  }
}

const folder = (use: string) => store.listFolders(accountId).find((f) => f.specialUse === use)!
const byPath = (p: string) => store.listFolders(accountId).find((f) => f.path === p)
const visible = (folderId: number) => store.listMessages(folderId, 0, 100).items
const idOf = (subject: string, folderId = folder('inbox').id) => visible(folderId).find((m) => m.subject === subject)!.id

beforeAll(async () => {
  other = new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user: USER, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })
  await other.connect()
  for (const s of ['Do koša', 'Vrátiť späť', 'Neskoro', 'Archivovať', 'Spam správa', 'Do projektu', 'Natrvalo', 'Odmietnutá', 'Druhá do koša']) await other.append('INBOX', msg(s), [])

  const dir = mkdtempSync(join(tmpdir(), 'doar-actions-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit: () => {}, undoDelayMs: DELAY })
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: USER, displayName: 'Jozef', username: USER,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: true, providerKey: null
    },
    password: srv.password,
    rememberPassword: true
  })
  accountId = acc.id
  sync.startAll()
  await until(() => sync.get(accountId)!.status.lastSync !== null && store.countNeedingBodies(accountId) === 0)
})

afterAll(async () => {
  await sync?.stopAll()
  await other?.logout()
})

describe('presuny a mazanie', () => {
  it('do Koša: hneď zmizne zo zoznamu, po čase na „Vrátiť späť“ je v Koši na serveri aj v Doare (bez nového sťahovania)', async () => {
    const id = idOf('Do koša')
    const r = sync.moveMessages([id], { special: 'trash' })
    expect(r.count).toBe(1)
    expect(visible(folder('inbox').id).some((m) => m.id === id)).toBe(false)
    expect(await serverSubjects('INBOX')).toContain('Do koša') // ešte čaká na uplynutie času
    await until(async () => (await serverSubjects('Trash')).includes('Do koša'))
    expect(await serverSubjects('INBOX')).not.toContain('Do koša')
    await until(() => visible(folder('trash').id).some((m) => m.subject === 'Do koša'))
    const moved = visible(folder('trash').id).find((m) => m.subject === 'Do koša')!
    expect(moved.id).toBe(id) // ten istý lokálny záznam – nové UID od servera (UIDPLUS)
    expect(moved.downloaded).toBe(true)
  })

  it('Vrátiť späť pred uplynutím času: správa sa vráti a server sa nezmení', async () => {
    const id = idOf('Vrátiť späť')
    const { undo } = sync.moveMessages([id], { special: 'trash' })
    expect(sync.undo(undo)).toEqual({ undone: true })
    expect(visible(folder('inbox').id).some((m) => m.id === id)).toBe(true)
    await new Promise((r) => setTimeout(r, DELAY * 3))
    expect(await serverSubjects('INBOX')).toContain('Vrátiť späť')
    expect(await serverSubjects('Trash')).not.toContain('Vrátiť späť')
  })

  it('Vrátiť späť po vykonaní: už sa nedá – Doar to povie', async () => {
    const { undo } = sync.moveMessages([idOf('Neskoro')], { special: 'trash' })
    await until(async () => (await serverSubjects('Trash')).includes('Neskoro'))
    expect(sync.undo(undo)).toEqual({ undone: false })
  })

  it('Archív, ktorý server neoznačil: Doar použije/založí priečinok Archive', async () => {
    db.prepare(`UPDATE folders SET special_use = NULL WHERE account_id = ? AND special_use = 'archive'`).run(accountId)
    sync.moveMessages([idOf('Archivovať')], { special: 'archive' })
    await until(async () => (await serverSubjects('Archive')).includes('Archivovať'))
    expect(folder('archive').path).toBe('Archive')
  })

  it('Spam a späť do Doručenej pošty', async () => {
    sync.moveMessages([idOf('Spam správa')], { special: 'junk' })
    await until(async () => (await serverSubjects('Junk')).includes('Spam správa'))
    await until(() => visible(folder('junk').id).some((m) => m.subject === 'Spam správa'))
    sync.moveMessages([idOf('Spam správa', folder('junk').id)], { special: 'inbox' })
    await until(async () => (await serverSubjects('INBOX')).includes('Spam správa'))
  })

  it('nový vnorený priečinok s diakritikou a presun do neho', async () => {
    const parentId = await sync.createFolder(accountId, null, 'Projekty')
    const childId = await sync.createFolder(accountId, parentId, 'Žltá ponorka')
    expect(byPath('Projekty/Žltá ponorka')?.id).toBe(childId)
    await expect(sync.createFolder(accountId, null, 'Projekty')).rejects.toMatchObject({ code: 'FOLDER_EXISTS' })
    await expect(sync.createFolder(accountId, null, 'a/b')).rejects.toMatchObject({ code: 'INVALID_FOLDER_NAME' })
    await expect(sync.createFolder(accountId, null, '  ')).rejects.toMatchObject({ code: 'INVALID_FOLDER_NAME' })
    sync.moveMessages([idOf('Do projektu')], { folderId: childId })
    await until(async () => (await serverSubjects('Projekty/Žltá ponorka')).includes('Do projektu'))
  })

  it('natrvalo vymazať: zmizne zo servera aj z Doaru', async () => {
    const id = idOf('Natrvalo')
    sync.deleteForever([id])
    expect(visible(folder('inbox').id).some((m) => m.id === id)).toBe(false)
    await until(async () => !(await serverSubjects('INBOX')).includes('Natrvalo'))
    expect((await serverSubjects('Trash')).includes('Natrvalo')).toBe(false)
    await until(() => store.message(id) === null)
  })

  it('server presun opakovane odmietne → správa sa znova zobrazí, označená ako neúspešná', async () => {
    const tmpId = await sync.createFolder(accountId, null, 'Dočasný')
    const id = idOf('Odmietnutá')
    sync.moveMessages([id], { folderId: tmpId })
    await other.mailboxDelete('Dočasný') // cieľ zmizne skôr, než sa presun vykoná
    await until(() => store.message(id)?.local_state === 'failed', 20_000)
    // Ďalšie pokusy spustí ďalšia synchronizácia; po 3 odmietnutiach sa správa vráti do zoznamu.
    for (let i = 0; i < 3; i++) await sync.syncNow(accountId)
    await until(() => visible(folder('inbox').id).some((m) => m.id === id))
    expect(visible(folder('inbox').id).find((m) => m.id === id)!.localState).toBe('failed')
    expect(await serverSubjects('INBOX')).toContain('Odmietnutá')
  })

  it('viac správ naraz a „Vybrať všetko“', async () => {
    const before = store.listIds(folder('inbox').id)
    expect(before.length).toBe(visible(folder('inbox').id).length)
    const ids = [idOf('Druhá do koša'), idOf('Vrátiť späť')]
    expect(sync.moveMessages(ids, { special: 'trash' }).count).toBe(2)
    expect(store.listIds(folder('inbox').id).length).toBe(before.length - 2)
    await until(async () => {
      const t = await serverSubjects('Trash')
      return t.includes('Druhá do koša') && t.includes('Vrátiť späť')
    })
  })

  it('pád aplikácie počas vykonávania: operácia sa po spustení zopakuje', () => {
    const opId = store.enqueueOperation(accountId, 'flags', { folderId: folder('inbox').id, uids: [], messageIds: [], add: [], remove: [] })
    expect(store.claimOperation(opId)).toBe(true)
    store.resetRunningOperations()
    expect((db.prepare('SELECT state FROM operations WHERE id = ?').get(opId) as { state: string }).state).toBe('pending')
  })
})
