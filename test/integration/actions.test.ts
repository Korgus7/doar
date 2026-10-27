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
  for (const s of ['Do koša', 'Vrátiť späť', 'Neskoro', 'Archivovať', 'Spam správa', 'Do projektu', 'Natrvalo', 'Odmietnutá', 'Druhá do koša', 'Hneď v cieli', 'Späť z cieľa', 'Najprv sem', 'Skupina A', 'Skupina B']) await other.append('INBOX', msg(s), [])

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

  it('odstránenie priečinka s podpriečinkom: správy do Koša, priečinky zmiznú', async () => {
    const parentId = await sync.createFolder(accountId, null, 'Staré')
    await sync.createFolder(accountId, parentId, 'Ešte staršie')
    await other.append('Staré', msg('Zo starého'), [])
    await other.append('Staré/Ešte staršie', msg('Z ešte staršieho'), [])
    await expect(sync.deleteFolder(folder('inbox').id)).rejects.toMatchObject({ code: 'FOLDER_PROTECTED' })
    await expect(sync.deleteFolder(folder('trash').id)).rejects.toMatchObject({ code: 'FOLDER_PROTECTED' })
    expect(await sync.deleteFolder(parentId)).toEqual({ moved: 2, labelsOnly: false })
    expect(byPath('Staré')).toBeUndefined()
    expect(byPath('Staré/Ešte staršie')).toBeUndefined()
    expect((await other.list()).some((f) => f.path.startsWith('Staré'))).toBe(false)
    expect(await serverSubjects('Trash')).toEqual(expect.arrayContaining(['Zo starého', 'Z ešte staršieho']))
    await until(() => visible(folder('trash').id).some((m) => m.subject === 'Z ešte staršieho'))
  })

  it('premenovanie a presun priečinka: správy aj ID ostanú, podpriečinky idú s ním', async () => {
    const parentId = await sync.createFolder(accountId, null, 'Klienti')
    const childId = await sync.createFolder(accountId, parentId, 'Firma A')
    await other.append('Klienti/Firma A', msg('Od firmy A'), [])
    await sync.syncNow(accountId)
    await until(() => visible(childId).some((m) => m.subject === 'Od firmy A'))
    const msgId = visible(childId)[0]!.id

    await sync.renameFolder(parentId, 'Zákazníci', null)
    expect(byPath('Zákazníci')?.id).toBe(parentId)
    expect(byPath('Zákazníci/Firma A')?.id).toBe(childId)
    expect(byPath('Klienti')).toBeUndefined()
    expect(visible(childId).map((m) => m.id)).toEqual([msgId])
    expect(await serverSubjects('Zákazníci/Firma A')).toEqual(['Od firmy A'])

    // Podpriečinok o úroveň vyššie (na najvyššiu úroveň) a späť pod iný priečinok.
    await sync.renameFolder(childId, 'Firma A', null)
    expect(byPath('Firma A')?.id).toBe(childId)
    expect(store.listFolders(accountId).find((f) => f.id === childId)?.depth).toBe(0)
    await sync.renameFolder(childId, 'Firma A', parentId)
    expect(byPath('Zákazníci/Firma A')?.id).toBe(childId)
    await sync.syncNow(accountId)
    expect(visible(childId).map((m) => m.id)).toEqual([msgId])

    await expect(sync.renameFolder(parentId, 'X', childId)).rejects.toMatchObject({ code: 'FOLDER_INTO_ITSELF' })
    await expect(sync.renameFolder(folder('inbox').id, 'Iná', null)).rejects.toMatchObject({ code: 'FOLDER_PROTECTED' })
    await expect(sync.renameFolder(folder('sent').id, 'Iná', null)).rejects.toMatchObject({ code: 'FOLDER_PROTECTED' })
    await expect(sync.renameFolder(childId, 'a/b', parentId)).rejects.toMatchObject({ code: 'INVALID_FOLDER_NAME' })
    await sync.createFolder(accountId, null, 'Obsadené')
    await expect(sync.renameFolder(parentId, 'Obsadené', null)).rejects.toMatchObject({ code: 'FOLDER_EXISTS' })
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
    // Cieľ zmizne na serveri (iný program) skôr, než sa o tom Doar dozvie – presun server odmietne.
    await other.mailboxDelete('Dočasný')
    sync.moveMessages([id], { folderId: tmpId })
    await new Promise((r) => setTimeout(r, DELAY + 200)) // čas na „Vrátiť späť“
    // Každá synchronizácia presun skúsi znova; po 3 odmietnutiach sa správa vráti do zoznamu ako neúspešná.
    // (Predtým test čakal, že pokusy spustí niečo samo – podľa načasovania to občas nestihlo.)
    for (let i = 0; i < 6 && store.message(id)?.local_state !== 'failed'; i++) await sync.syncNow(accountId)
    expect(store.message(id)?.local_state).toBe('failed')
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

describe('presun sa ukáže hneď v cieľovom priečinku', () => {
  const inTarget = (folderId: number, subject: string) => visible(folderId).filter((m) => m.subject === subject)

  it('hneď v cieli so značkou „presúva sa“, počty priečinkov sedia; po vykonaní ten istý záznam, bez duplicity', async () => {
    const trash = folder('trash').id
    const inbox = folder('inbox').id
    const before = store.listFolders(accountId).find((f) => f.id === trash)!.localCount
    const id = idOf('Hneď v cieli')
    sync.moveMessages([id], { special: 'trash' })
    expect(visible(inbox).some((m) => m.id === id)).toBe(false)
    const now = inTarget(trash, 'Hneď v cieli')
    expect(now).toHaveLength(1)
    expect(now[0]).toMatchObject({ id, folderId: trash, localState: 'pending' })
    expect(store.listFolders(accountId).find((f) => f.id === trash)!.localCount).toBe(before + 1)
    expect(store.listIds(trash)).toContain(id)
    expect(await serverSubjects('INBOX')).toContain('Hneď v cieli') // server ešte čaká
    await until(async () => (await serverSubjects('Trash')).includes('Hneď v cieli'))
    await until(() => inTarget(trash, 'Hneď v cieli')[0]?.localState === 'synced')
    await sync.syncNow(accountId)
    expect(inTarget(trash, 'Hneď v cieli')).toHaveLength(1)
    expect(inTarget(trash, 'Hneď v cieli')[0]!.id).toBe(id)
  })

  it('Vrátiť späť: zmizne z cieľa a je späť v pôvodnom priečinku', async () => {
    const trash = folder('trash').id
    const id = idOf('Späť z cieľa')
    const { undo } = sync.moveMessages([id], { special: 'trash' })
    expect(inTarget(trash, 'Späť z cieľa')).toHaveLength(1)
    expect(sync.undo(undo)).toEqual({ undone: true })
    expect(inTarget(trash, 'Späť z cieľa')).toHaveLength(0)
    expect(visible(folder('inbox').id).find((m) => m.id === id)?.localState).toBe('synced')
  })

  it('ďalší presun počas čakania: platí posledná voľba, ostatné správy z prvého presunu idú pôvodne', async () => {
    const trash = folder('trash').id
    const archive = folder('archive').id
    const a = idOf('Skupina A')
    const b = idOf('Skupina B')
    const n = idOf('Najprv sem')
    sync.moveMessages([a, b, n], { special: 'trash' })
    expect(inTarget(trash, 'Najprv sem')).toHaveLength(1)
    // Používateľ si to rozmyslí: jednu z troch hneď presunie do Archívu.
    sync.moveMessages([n], { special: 'archive' })
    expect(inTarget(trash, 'Najprv sem')).toHaveLength(0)
    expect(inTarget(archive, 'Najprv sem')).toHaveLength(1)
    expect(inTarget(trash, 'Skupina A')).toHaveLength(1)
    await until(async () => (await serverSubjects('Archive')).includes('Najprv sem') && (await serverSubjects('Trash')).includes('Skupina B'))
    expect(await serverSubjects('Trash')).not.toContain('Najprv sem')
    expect(await serverSubjects('Trash')).toContain('Skupina A')
    expect(await serverSubjects('INBOX')).not.toContain('Najprv sem')
    await sync.syncNow(accountId)
    expect(inTarget(archive, 'Najprv sem')).toHaveLength(1)
    expect(inTarget(trash, 'Najprv sem')).toHaveLength(0)
    expect(visible(folder('inbox').id).some((m) => ['Skupina A', 'Skupina B', 'Najprv sem'].includes(m.subject))).toBe(false)
  })
})
