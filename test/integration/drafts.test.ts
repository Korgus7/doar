import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets } from '../../src/core/secrets'
import { addAccount } from '../../src/core/accounts'
import { SyncManager } from '../../src/core/sync/manager'
import { createHandlers, type Handlers } from '../../src/core/handlers'
import { FileGrants } from '../../src/core/files'
import { ExportManager } from '../../src/core/export/manager'
import type { DraftSaveInput } from '../../src/shared/ipc'

const srv = inject('testserver')
const USER = 'olga@doar.test'
const TO = 'pavol@doar.test'
const DELAY = 600

let db: Db
let store: MailStore
let sync: SyncManager
let h: Handlers
let files: FileGrants
let accountId: number
let dir: string

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })

/** Obsah priečinka na serveri (overenie iným klientom). */
async function folder(user: string, path: string): Promise<{ uid: number; subject: string; flags: string[]; source: Buffer }[]> {
  const c = imap(user)
  await c.connect()
  try {
    const lock = await c.getMailboxLock(path)
    try {
      if (!c.mailbox || !c.mailbox.exists) return []
      const out: { uid: number; subject: string; flags: string[]; source: Buffer }[] = []
      for await (const m of c.fetch('1:*', { uid: true, envelope: true, flags: true, source: true })) {
        out.push({ uid: m.uid, subject: m.envelope?.subject ?? '', flags: [...(m.flags ?? [])], source: m.source! })
      }
      return out
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
}

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('časový limit')
}

const draftsFolder = () => store.listFolders(accountId).find((f) => f.specialUse === 'drafts')!
const localDrafts = () => store.listMessages(draftsFolder().id, 0, 50).items
const base = (over: Partial<DraftSaveInput> = {}): DraftSaveInput => ({
  draftId: null, accountId, to: '', cc: '', bcc: '', subject: '', text: '', replyToMessage: null, attachments: [], ...over
})

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'doar-drafts-'))
  db = openDb(join(dir, 'doar.db'))
  store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  const secrets = new MemorySecrets(true)
  const acc = await addAccount(db, secrets, secrets, {
    settings: {
      email: USER, displayName: 'Oľga', username: USER,
      imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
      smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
      saveSentCopy: false, providerKey: null
    },
    password: srv.password,
    rememberPassword: true
  })
  accountId = acc.id
  const emit = () => {}
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets: new MemorySecrets(), emit, draftDelayMs: DELAY })
  files = new FileGrants()
  h = createHandlers({
    files, db, blobs, store, sync, secrets,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }), sessionSecrets: new MemorySecrets(), emit,
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
  sync.startAll()
  await until(() => sync.get(accountId)!.status.lastSync !== null)
})

afterAll(async () => {
  await sync?.stopAll()
})

describe('koncepty', () => {
  let draftId: number

  it('uloženie: hneď lokálne, na server až po odstupe; ďalšie uloženia nahradia verziu na serveri', async () => {
    const r = await h['drafts.save'](base({ to: 'Pavol <pavol@doar.test>, zly@', subject: 'Rozpísaná ponuka', text: 'Prvá verzia' }))
    draftId = r.draftId
    expect(store.draft(draftId)?.rev).toBe(1)
    expect(await folder(USER, 'Drafts')).toHaveLength(0) // ešte nie na serveri
    await until(async () => (await folder(USER, 'Drafts')).length === 1)
    const first = (await folder(USER, 'Drafts'))[0]!
    expect(first.subject).toBe('Rozpísaná ponuka')
    expect(first.flags).toContain('\\Draft')

    // Rýchle uloženia za sebou → na serveri vždy len jedna (posledná) verzia.
    await h['drafts.save'](base({ draftId, to: 'Pavol <pavol@doar.test>', subject: 'Ponuka v2', text: 'Druhá' }))
    await h['drafts.save'](base({ draftId, to: 'Pavol <pavol@doar.test>', subject: 'Ponuka v3', text: 'Tretia verzia', flush: true }))
    await until(async () => {
      const list = await folder(USER, 'Drafts')
      return list.length === 1 && list[0]!.subject === 'Ponuka v3'
    })
    expect((await folder(USER, 'Drafts'))[0]!.uid).not.toBe(first.uid)
    // V Doare sa zobrazí v Konceptoch (a len raz).
    await until(() => localDrafts().length === 1 && localDrafts()[0]!.subject === 'Ponuka v3')
  })

  it('otvorenie z Konceptov: lokálna verzia so všetkými poliami (aj s neplatnou adresou)', async () => {
    await h['drafts.save'](base({ draftId, to: 'Pavol <pavol@doar.test>, zly@', bcc: 'tajny@doar.test', subject: 'Ponuka v3', text: 'Tretia verzia', flush: true }))
    await until(async () => (await folder(USER, 'Drafts')).length === 1 && (await folder(USER, 'Drafts'))[0]!.source.toString().includes('tajny@doar.test'))
    await until(() => localDrafts().length === 1)
    const pre = await h['compose.prepare']({ mode: 'draft', messageId: localDrafts()[0]!.id })
    expect(pre.draftId).toBe(draftId)
    expect(pre.draft).toEqual({ to: 'Pavol <pavol@doar.test>, zly@', cc: '', bcc: 'tajny@doar.test', text: 'Tretia verzia', html: null })
    expect(pre.subject).toBe('Ponuka v3')
  })

  it('prílohy: súbor sa uloží do konceptu (funguje aj po zmazaní z disku) a je aj na serveri', async () => {
    const file = join(dir, 'Rozpočet.xlsx')
    writeFileSync(file, 'tabuľka')
    files.allow(file, 'read')
    const r = await h['drafts.save'](base({ draftId, to: TO, subject: 'Ponuka v4', text: 'S prílohou', attachments: [{ kind: 'file', path: file }], flush: true }))
    expect(r.attachments).toEqual([{ kind: 'blob', sha: expect.stringMatching(/^[0-9a-f]{64}$/), name: 'Rozpočet.xlsx', contentType: undefined }])
    rmSync(file)
    await h['drafts.save'](base({ draftId, to: TO, subject: 'Ponuka v5', text: 'S prílohou', attachments: r.attachments, flush: true }))
    let src: Buffer | null = null
    await until(async () => {
      const list = await folder(USER, 'Drafts')
      src = list.length === 1 && list[0]!.subject === 'Ponuka v5' ? list[0]!.source : null
      return src !== null
    })
    const p = await simpleParser(src!)
    expect(p.attachments.map((a) => [a.filename, a.content.toString()])).toEqual([['Rozpočet.xlsx', 'tabuľka']])
  })

  it('cudzí obsah úložiska sa ako príloha použiť nedá', async () => {
    const sha = 'a'.repeat(64)
    await expect(
      h['compose.send']({ accountId, to: TO, cc: '', bcc: '', subject: 'x', text: '', replyToMessage: null, attachments: [{ kind: 'blob', sha, name: 'x' }] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('odoslanie konceptu: adresát ho dostane, z Konceptov zmizne (aj na serveri)', async () => {
    const d = store.draft(draftId)!
    const atts = (JSON.parse(d.attachments_json) as { sha: string; name: string }[]).map((a) => ({ kind: 'blob' as const, sha: a.sha, name: a.name }))
    await h['compose.send']({ accountId, to: TO, cc: '', bcc: '', subject: 'Ponuka v5', text: 'S prílohou', replyToMessage: null, attachments: atts, draftId })
    await until(() => localDrafts().length === 0) // hneď skrytý
    await until(async () => (await folder(USER, 'Drafts')).length === 0)
    await until(() => store.draft(draftId) === null)
    await until(async () => (await folder(TO, 'INBOX')).some((m) => m.subject === 'Ponuka v5'))
    const got = (await folder(TO, 'INBOX')).find((m) => m.subject === 'Ponuka v5')!
    expect((await simpleParser(got.source)).attachments[0]?.filename).toBe('Rozpočet.xlsx')
  })

  it('koncept z iného programu: otvorí sa, úprava nahradí pôvodný na serveri', async () => {
    const c = imap(USER)
    await c.connect()
    await c.append(
      'Drafts',
      Buffer.from('From: olga@doar.test\r\nTo: pavol@doar.test\r\nCc: Ema <ema@doar.test>\r\nSubject: Z mobilu\r\nMessage-ID: <z-mobilu-1@doar.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNapísané v mobile\r\n'),
      ['\\Draft']
    )
    await c.logout()
    await sync.syncNow(accountId)
    await until(() => localDrafts().some((m) => m.subject === 'Z mobilu'))
    const pre = await h['compose.prepare']({ mode: 'draft', messageId: localDrafts().find((m) => m.subject === 'Z mobilu')!.id })
    expect(pre.draft?.text.trim()).toBe('Napísané v mobile')
    expect(pre.draft?.cc).toBe('Ema <ema@doar.test>')
    expect(pre.draftId).not.toBeNull()
    await h['drafts.save'](base({ draftId: pre.draftId, to: pre.draft!.to, cc: pre.draft!.cc, subject: 'Z mobilu – doplnené', text: 'Doplnené v Doare', flush: true }))
    await until(async () => {
      const list = await folder(USER, 'Drafts')
      return list.length === 1 && list[0]!.subject === 'Z mobilu – doplnené'
    })
    // Message-ID zostáva – iné programy ho stále poznajú ako ten istý koncept.
    expect((await folder(USER, 'Drafts'))[0]!.source.toString()).toMatch(/^Message-ID: <z-mobilu-1@doar\.test>/im)
    draftId = pre.draftId!
  })

  it('zahodenie: zmizne zo servera aj z Doaru', async () => {
    await h['drafts.discard']({ draftId })
    await until(async () => (await folder(USER, 'Drafts')).length === 0)
    await until(() => store.draft(draftId) === null && localDrafts().length === 0)
  })

  it('zahodenie konceptu, ktorý ešte nebol na serveri, nič na server nenahrá', async () => {
    const { draftId: id } = await h['drafts.save'](base({ subject: 'Hneď zahodený', text: 'x' }))
    await h['drafts.discard']({ draftId: id })
    await new Promise((r) => setTimeout(r, DELAY * 3))
    expect(await folder(USER, 'Drafts')).toHaveLength(0)
    expect(store.draft(id)).toBeNull()
  })
})
