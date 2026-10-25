import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { testAccessToken } from '../../scripts/testserver.mjs'
import { openDb, type Db } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { MemorySecrets, passwordKey } from '../../src/core/secrets'
import { SyncManager } from '../../src/core/sync/manager'
import { createHandlers, type Handlers } from '../../src/core/handlers'
import { FileGrants } from '../../src/core/files'
import { ExportManager } from '../../src/core/export/manager'
import { ImportManager } from '../../src/core/import/manager'
import { ArchiveManager } from '../../src/core/archive/archive'
import { OAuthService, oauthConfig, oauthKey } from '../../src/core/oauth/oauth'
import type { AccountSettings } from '../../src/shared/ipc'

const srv = inject('testserver')
const USER = 'ivan@doar.test'
const TO = 'karol@doar.test'

/** Falošný autorizačný server (Microsoft/Google): overí PKCE, vydá tokeny pre testovací poštový server. */
class FakeAuth {
  server: Server
  base = ''
  challenges = new Map<string, string>()
  refreshes = 0
  issued: string[] = []
  ttlMs = 3600_000
  constructor() {
    this.server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x')
      if (u.pathname === '/authorize') {
        const redirect = new URL(u.searchParams.get('redirect_uri')!)
        redirect.searchParams.set('state', u.searchParams.get('state')!)
        if (u.searchParams.get('login_hint') === 'odmietnem@doar.test') redirect.searchParams.set('error', 'access_denied')
        else {
          const code = `code-${this.challenges.size + 1}`
          this.challenges.set(code, u.searchParams.get('code_challenge')!)
          redirect.searchParams.set('code', code)
        }
        res.writeHead(302, { location: redirect.toString() }).end()
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const p = new URLSearchParams(body)
        const json = (status: number, o: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o))
        if (p.get('client_id') !== 'doar-test') return json(401, { error: 'invalid_client' })
        const idToken = `x.${Buffer.from(JSON.stringify({ email: USER })).toString('base64url')}.y`
        if (p.get('grant_type') === 'authorization_code') {
          const challenge = this.challenges.get(p.get('code') ?? '')
          const ok = challenge && createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') === challenge
          if (!ok) return json(400, { error: 'invalid_grant', error_description: 'PKCE' })
          const at = testAccessToken(USER, this.ttlMs)
          this.issued.push(at)
          return json(200, { access_token: at, refresh_token: 'rt-1', expires_in: Math.round(this.ttlMs / 1000), id_token: idToken })
        }
        if (p.get('grant_type') === 'refresh_token') {
          if (p.get('refresh_token') === 'revoked') return json(400, { error: 'invalid_grant' })
          this.refreshes++
          const at = testAccessToken(USER, this.ttlMs)
          this.issued.push(at)
          return json(200, { access_token: at, refresh_token: `rt-${this.refreshes + 1}`, expires_in: Math.round(this.ttlMs / 1000) })
        }
        json(400, { error: 'unsupported_grant_type' })
      })
    })
  }
  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
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

const auth = new FakeAuth()
let db: Db
let h: Handlers
let sync: SyncManager
let oauth: OAuthService
const secrets = new MemorySecrets(true)
const sessionSecrets = new MemorySecrets()

const settings: AccountSettings = {
  email: USER,
  displayName: 'Hana',
  username: USER,
  imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
  smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
  saveSentCopy: false,
  providerKey: 'microsoft'
}

/** „Prehliadač“: otvorí adresu prihlásenia, server presmeruje na spätné volanie Doar Mail. */
async function browse(url: string): Promise<{ status: number; html: string }> {
  const r = await fetch(url)
  return { status: r.status, html: await r.text() }
}

async function signIn(loginHint = USER): Promise<string> {
  const { flowId, url } = await h['oauth.start']({ provider: 'microsoft', loginHint, lang: 'sk', text: { title: 'Doar Mail', done: 'Prihlásenie hotové', failed: 'Nepodarilo sa' } })
  const page = await browse(url)
  expect(page.html).toContain('Prihlásenie hotové')
  await h['oauth.finish']({ flowId })
  return flowId
}

beforeAll(async () => {
  await auth.listen()
  const c = new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user: USER, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })
  await c.connect()
  await c.append('INBOX', Buffer.from(`From: Eva <eva@doar.test>\r\nTo: ${USER}\r\nSubject: Vitaj cez OAuth\r\nDate: ${new Date().toUTCString()}\r\n\r\nAhoj\r\n`), [])
  await c.logout()

  const dir = mkdtempSync(join(tmpdir(), 'doar-oauth-'))
  db = openDb(join(dir, 'doar.db'))
  const store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  oauth = new OAuthService({ secrets, sessionSecrets, config: oauthConfig({ DOAR_OAUTH_TEST_URL: auth.base }) })
  const emit = (): void => {}
  sync = new SyncManager({ db, store, blobs, secrets, sessionSecrets, emit, oauth, undoDelayMs: 300 })
  h = createHandlers({
    files: new FileGrants(), db, blobs, store, sync, secrets, sessionSecrets, emit, oauth,
    exports: new ExportManager({ db, store, blobs, emit, newClient: (id) => sync.newImapClient(id) }),
    imports: new ImportManager({ db, store, blobs, emit, files: new FileGrants(), newClient: (id) => sync.newImapClient(id) }),
    archives: new ArchiveManager({ db, files: new FileGrants(), emit }),
    dataDir: dir, appVersion: 'test', sqlite: 'x',
    net: { fetchText: async () => null, resolveSrv: async () => [], resolveMx: async () => [], probe: async () => ({ ok: false }) }
  })
})

afterAll(async () => {
  await sync?.stopAll()
  auth.server.close()
})

describe('prihlásenie cez Microsoft/Google (OAuth)', () => {
  let accountId = 0

  it('adresa prihlásenia: PKCE (S256), náhodný state, spätné volanie na 127.0.0.1, login_hint', async () => {
    const { flowId, url } = await h['oauth.start']({ provider: 'google', loginHint: USER })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe(`${auth.base}/authorize`)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(u.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32)
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(u.searchParams.get('login_hint')).toBe(USER)
    // Cudzia požiadavka na spätné volanie (zlý state) prihlásenie nedokončí.
    const cb = new URL(u.searchParams.get('redirect_uri')!)
    cb.searchParams.set('code', 'podvrh')
    cb.searchParams.set('state', 'zly')
    expect((await browse(cb.toString())).status).toBe(400)
    h['oauth.cancel']({ flowId })
    await expect(h['oauth.finish']({ flowId })).rejects.toMatchObject({ code: expect.stringMatching(/OAUTH_(CANCELLED|FAILED)/) })
  })

  it('používateľ prihlásenie odmietne → OAUTH_CANCELLED', async () => {
    const { flowId, url } = await h['oauth.start']({ provider: 'microsoft', loginHint: 'odmietnem@doar.test' })
    await browse(url)
    await expect(h['oauth.finish']({ flowId })).rejects.toMatchObject({ code: 'OAUTH_CANCELLED' })
  })

  it('prihlásenie → overenie IMAP aj SMTP tokenom → konto bez hesla, refresh token v bezpečnom úložisku', async () => {
    const flowId = await signIn()
    const test = await h['accounts.test']({ settings, password: '', oauth: { flowId } })
    expect(test.imap).toMatchObject({ ok: true })
    expect(test.smtp).toMatchObject({ ok: true })
    const acc = await h['accounts.add']({ settings: { ...settings, email: 'preklep@doar.test' }, password: '', oauth: { flowId }, rememberPassword: true })
    accountId = acc.id
    expect(acc.email).toBe(USER) // adresa z prihlásenia má prednosť pred preklepom
    const details = await h['accounts.get']({ id: accountId })
    expect(details).toMatchObject({ authType: 'oauth2', oauthProvider: 'microsoft', passwordStorage: 'os' })
    expect(await secrets.get(passwordKey(accountId))).toBeNull()
    expect(JSON.parse((await secrets.get(oauthKey(accountId)))!)).toEqual({ provider: 'microsoft', refreshToken: 'rt-1' })
    expect(JSON.stringify(db.prepare('SELECT * FROM accounts').all())).not.toContain('rt-1')
    await until(() => sync.get(accountId)?.status.lastSync != null)
    const list = await h['messages.list']({ folderId: null, offset: 0, limit: 10 })
    expect(list.items.map((m) => m.subject)).toContain('Vitaj cez OAuth')
  })

  it('odoslanie cez SMTP s tokenom', async () => {
    const { outboxId } = await h['compose.send']({ accountId, to: TO, cc: '', bcc: '', subject: 'Poslané s tokenom', text: 'Funguje.', replyToMessage: null })
    await until(() => (db.prepare('SELECT state FROM outbox WHERE id = ?').get(outboxId) as { state: string }).state === 'sent')
    const c = new ImapFlow({ host: '127.0.0.1', port: srv.ports.imaps, secure: true, auth: { user: TO, pass: srv.password }, tls: { ca: readFileSync(srv.caPath) }, logger: false })
    await c.connect()
    await c.mailboxOpen('INBOX')
    const subjects: string[] = []
    for await (const m of c.fetch('1:*', { envelope: true })) subjects.push(m.envelope?.subject ?? '')
    await c.logout()
    expect(subjects).toContain('Poslané s tokenom')
  })

  it('obnova tokenu (aj s novým refresh tokenom), vypršané prihlásenie a nové prihlásenie', async () => {
    // Nové spojenie s neplatným (zabudnutým) tokenom → obnova cez refresh token.
    oauth.invalidate(accountId)
    const c = await sync.newImapClient(accountId)
    await c.connect()
    await c.logout()
    expect(auth.refreshes).toBe(1)
    expect(JSON.parse((await secrets.get(oauthKey(accountId)))!).refreshToken).toBe('rt-2')
    expect(sync.get(accountId)!.status.state).not.toBe('error')

    // Prihlásenie zrušené u poskytovateľa → OAUTH_EXPIRED, synchronizácia sa nezacyklí.
    await secrets.set(oauthKey(accountId), JSON.stringify({ provider: 'microsoft', refreshToken: 'revoked' }))
    oauth.invalidate(accountId)
    await sync.restart(accountId)
    await until(() => sync.get(accountId)?.status.code === 'OAUTH_EXPIRED')

    // Nové prihlásenie toho istého účtu → znova funguje.
    const flowId = await signIn()
    await h['accounts.reauth']({ id: accountId, flowId })
    await until(() => sync.get(accountId)!.status.state !== 'error' && sync.get(accountId)!.status.lastSync != null)
    expect(JSON.parse((await secrets.get(oauthKey(accountId)))!).refreshToken).toBe('rt-1')
  })

  it('odstránenie konta zmaže aj prihlásenie', async () => {
    await h['accounts.remove']({ id: accountId })
    expect(await secrets.get(oauthKey(accountId))).toBeNull()
  })
})
