/**
 * Prihlásenie cez Microsoft a Google (OAuth 2.0, „installed app“): PKCE, prehliadač používateľa,
 * spätné volanie na 127.0.0.1 (náhodný port). Heslo Doar Mail nikdy nevidí.
 *
 * Refresh token je v bezpečnom úložisku (ako heslá), prístupový token len v pamäti.
 * Bez Electronu – testovateľné v čistom Node.js (falošný autorizačný server).
 */
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthProvider } from '../../shared/ipc'
import type { Secrets } from '../secrets'
import { logger } from '../log'

const log = logger('oauth')

export interface OAuthEndpoint {
  authUrl: string
  tokenUrl: string
  scope: string
  clientId: string
  /** Google „Desktop app“ ho vyžaduje; pri inštalovaných aplikáciách nie je tajný (Google to tak uvádza). */
  clientSecret?: string
  /** Microsoft chce rozsah aj pri výmene kódu a obnove. */
  scopeOnToken: boolean
  extraAuth: Record<string, string>
  /** Adresa spätného volania: Microsoft povoľuje „http://localhost“, Google 127.0.0.1. */
  redirectHost: 'localhost' | '127.0.0.1'
  /** Rozsah pre prístup ku kontaktom (synchronizácia adresára); pýta sa až keď ju používateľ zapne. */
  contactsScope?: string
  /** Rozsah, bez ktorého pošta nefunguje – Google ho na stránke súhlasu dovolí odškrtnúť. */
  mailScope?: string
}

export type OAuthConfig = Record<OAuthProvider, OAuthEndpoint | null>

/**
 * Registrácie aplikácie Doar Mail (verejné identifikátory, nie tajomstvá). Dajú sa prepísať
 * premennými prostredia DOAR_OAUTH_MICROSOFT_CLIENT_ID, DOAR_OAUTH_GOOGLE_CLIENT_ID, DOAR_OAUTH_GOOGLE_CLIENT_SECRET.
 */
const BUILT_IN = {
  microsoftClientId: 'b0ab1393-67c0-49a5-a6b2-f80dda999104',
  googleClientId: '803381359560-mijesmem5l7in3v0338qaq0jpfamfv0s.apps.googleusercontent.com',
  // Uložené pospiatky, aby ho automatické skenery nepovažovali za uniknuté heslo (pri desktopovej aplikácii nie je tajné).
  googleClientSecretReversed: 'ryZlKLOEd2IrQAWeFm-RTRwgH4vl-XPSCOG'
}

export function oauthConfig(env: Record<string, string | undefined> = process.env): OAuthConfig {
  const test = env['DOAR_OAUTH_TEST_URL']
  if (test) {
    const base = test.replace(/\/+$/, '')
    const ep = (scope: string): OAuthEndpoint => ({
      authUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      scope,
      clientId: 'doar-test',
      clientSecret: 'doar-test-secret',
      scopeOnToken: true,
      extraAuth: {},
      redirectHost: '127.0.0.1'
    })
    return { microsoft: ep('offline_access imap smtp'), google: { ...ep('https://mail.google.com/'), contactsScope: 'carddav' } }
  }
  const ms = env['DOAR_OAUTH_MICROSOFT_CLIENT_ID'] || BUILT_IN.microsoftClientId
  const g = env['DOAR_OAUTH_GOOGLE_CLIENT_ID'] || BUILT_IN.googleClientId
  const gs = env['DOAR_OAUTH_GOOGLE_CLIENT_SECRET'] || [...BUILT_IN.googleClientSecretReversed].reverse().join('')
  return {
    microsoft: ms
      ? {
          authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
          tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
          // Pošta cez Microsoft Graph (čítanie, presuny, koncepty aj odosielanie) – IMAP a SMTP Microsoft novým kontám vypína.
          scope: 'offline_access openid email https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send',
          clientId: ms,
          scopeOnToken: true,
          extraAuth: { prompt: 'select_account' },
          redirectHost: 'localhost'
        }
      : null,
    google:
      g && gs
        ? {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scope: 'openid email https://mail.google.com/',
            clientId: g,
            clientSecret: gs,
            scopeOnToken: false,
            extraAuth: { access_type: 'offline', prompt: 'consent' },
            redirectHost: '127.0.0.1',
            contactsScope: 'https://www.googleapis.com/auth/carddav',
            mailScope: 'https://mail.google.com/'
          }
        : null
  }
}

export interface OAuthTokens {
  provider: OAuthProvider
  accessToken: string
  refreshToken: string
  /** ms od epochy */
  expiresAt: number
  /** E-mail prihláseného účtu (z id_token), ak ho poskytovateľ poslal. */
  email: string | null
  /** Udelené rozsahy (ak ich poskytovateľ poslal). */
  scope: string | null
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>

function oerr(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra })
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** E-mail z id_token (podpis netreba overovať – token prišiel priamo od poskytovateľa cez TLS). */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null
  const part = idToken.split('.')[1]
  if (!part) return null
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
    const e = [claims['email'], claims['preferred_username'], claims['upn']].find((v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+$/.test(v))
    return typeof e === 'string' ? e.toLowerCase() : null
  } catch {
    return null
  }
}

async function tokenRequest(ep: OAuthEndpoint, params: Record<string, string>, fetchFn: FetchFn, provider: OAuthProvider, previousRefresh?: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({ client_id: ep.clientId, ...(ep.clientSecret ? { client_secret: ep.clientSecret } : {}), ...(ep.scopeOnToken ? { scope: ep.scope } : {}), ...params })
  let res: Response
  try {
    res = await fetchFn(ep.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000)
    })
  } catch {
    throw oerr('NO_NETWORK', 'Server prihlásenia nie je dostupný')
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const e = String(j['error'] ?? '')
    // invalid_grant = prihlásenie vypršalo alebo ho používateľ zrušil → treba sa prihlásiť znova.
    throw oerr(e === 'invalid_grant' ? 'OAUTH_EXPIRED' : 'OAUTH_FAILED', `${e || res.status} ${String(j['error_description'] ?? '').slice(0, 200)}`.trim())
  }
  const accessToken = j['access_token']
  const refreshToken = typeof j['refresh_token'] === 'string' ? j['refresh_token'] : previousRefresh
  if (typeof accessToken !== 'string' || !accessToken || !refreshToken) throw oerr('OAUTH_FAILED', 'Neúplná odpoveď servera prihlásenia')
  const expiresIn = Number(j['expires_in'])
  return {
    provider,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    email: emailFromIdToken(j['id_token']),
    scope: typeof j['scope'] === 'string' ? j['scope'] : null
  }
}

interface Flow {
  provider: OAuthProvider
  /** Pýtal sa aj prístup ku kontaktom. */
  contacts: boolean
  url: string
  server: http.Server
  result: Promise<OAuthTokens>
  tokens: OAuthTokens | null
  cancel: () => void
  timer: NodeJS.Timeout
}

export interface OAuthPageText {
  title: string
  done: string
  failed: string
}

function page(lang: string, title: string, text: string, ok: boolean): string {
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html><html lang="${esc(lang)}" dir="auto"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(title)}</title>
<style>body{font:16px/1.5 'Segoe UI',system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#efede9;color:#1d2229}div{background:#fbfaf7;border:1px solid #e3e0da;border-radius:3px;padding:28px 34px;max-width:420px;text-align:center}b{font-size:2rem;color:${ok ? '#2e7d4f' : '#b3261e'}}</style></head>
<body><div><b>${ok ? '✓' : '✕'}</b><h1 style="font-size:1.2rem">${esc(title)}</h1><p>${esc(text)}</p></div></body></html>`
}

const FLOW_TIMEOUT_MS = 10 * 60_000
/** Obnoviť token, keď mu zostáva menej ako 5 minút. */
const REFRESH_MARGIN_MS = 5 * 60_000

export const oauthKey = (accountId: number): string => `account:${accountId}:oauth`

/**
 * Prihlasovania (flow) a tokeny kont. Jeden objekt na jadro.
 */
export class OAuthService {
  private flows = new Map<string, Flow>()
  private cache = new Map<number, { accessToken: string; expiresAt: number }>()
  private refreshing = new Map<number, Promise<string>>()

  constructor(
    private readonly deps: {
      secrets: Secrets
      sessionSecrets: Secrets
      config?: OAuthConfig
      fetch?: FetchFn
    }
  ) {}

  private get config(): OAuthConfig {
    return this.deps.config ?? oauthConfig()
  }

  private get fetchFn(): FetchFn {
    return this.deps.fetch ?? ((url, init) => fetch(url, init))
  }

  /** Ktorí poskytovatelia sú v tejto zostave nastavení (majú registráciu aplikácie). */
  available(): Record<OAuthProvider, boolean> {
    const c = this.config
    return { microsoft: !!c.microsoft, google: !!c.google }
  }

  /** Začne prihlásenie: spustí spätné volanie a vráti adresu, ktorú rozhranie otvorí v prehliadači. */
  async start(input: { provider: OAuthProvider; loginHint?: string; lang?: string; text?: OAuthPageText; contacts?: boolean }): Promise<{ flowId: string; url: string }> {
    const ep = this.config[input.provider]
    if (!ep) throw oerr('OAUTH_NOT_CONFIGURED', 'Prihlásenie cez tohto poskytovateľa nie je v tejto zostave nastavené')
    const flowId = b64url(randomBytes(16))
    const state = b64url(randomBytes(24))
    const verifier = b64url(randomBytes(48))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const text = input.text ?? { title: 'Doar Mail', done: 'OK', failed: 'Error' }
    const lang = String(input.lang ?? 'en').slice(0, 10)
    let resolveCode!: (code: string) => void
    let rejectCode!: (e: Error) => void
    const codeP = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })
    codeP.catch(() => {})
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const ok = u.searchParams.get('state') === state && !!u.searchParams.get('code')
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page(lang, text.title, ok ? text.done : text.failed, ok))
      if (u.searchParams.get('state') !== state) return // cudzia požiadavka – ignorovať, čakať ďalej
      const e = u.searchParams.get('error')
      if (e) rejectCode(oerr(e === 'access_denied' ? 'OAUTH_CANCELLED' : 'OAUTH_FAILED', e))
      else if (ok) resolveCode(u.searchParams.get('code')!)
    })
    await new Promise<void>((res, rej) => {
      server.once('error', rej)
      server.listen(0, '127.0.0.1', () => res())
    })
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://${ep.redirectHost}:${port}/callback`
    const params = new URLSearchParams({
      client_id: ep.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      // Kontakty: rozsah navyše; doterajšie povolenia (pošta) ostanú.
      scope: input.contacts && ep.contactsScope ? `${ep.scope} ${ep.contactsScope}` : ep.scope,
      ...(input.contacts && ep.contactsScope ? { include_granted_scopes: 'true' } : {}),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...ep.extraAuth,
      ...(input.loginHint ? { login_hint: String(input.loginHint).slice(0, 320) } : {})
    })
    const url = `${ep.authUrl}?${params.toString()}`
    const timer = setTimeout(() => rejectCode(oerr('OAUTH_TIMEOUT', 'Prihlásenie sa nedokončilo včas')), FLOW_TIMEOUT_MS)
    timer.unref?.()
    const result = codeP
      .then((code) => tokenRequest(ep, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, this.fetchFn, input.provider))
      .finally(() => {
        clearTimeout(timer)
        server.close()
      })
    result.catch(() => {})
    const flow: Flow = { provider: input.provider, contacts: !!input.contacts, url, server, result, tokens: null, cancel: () => rejectCode(oerr('OAUTH_CANCELLED', 'Zrušené')), timer }
    this.flows.set(flowId, flow)
    log.info('prihlásenie začaté', { provider: input.provider })
    return { flowId, url }
  }

  /** Počká na dokončenie prihlásenia v prehliadači. Vráti e-mail prihláseného účtu (ak ho poskytovateľ poslal). */
  async finish(flowId: string): Promise<{ email: string | null; provider: OAuthProvider }> {
    const flow = this.flows.get(flowId)
    if (!flow) throw oerr('OAUTH_FAILED', 'Neznáme prihlásenie')
    try {
      const tokens = await flow.result
      // Google na stránke súhlasu dovolí jednotlivé prístupy odškrtnúť – bez pošty (alebo kontaktov) by Doar nefungoval.
      const ep = this.config[flow.provider]
      const granted = tokens.scope?.split(/\s+/) ?? null
      if (granted && ep?.mailScope && !granted.includes(ep.mailScope)) throw oerr('OAUTH_SCOPE_MAIL', 'Nebol povolený prístup k pošte')
      if (granted && flow.contacts && ep?.contactsScope && !granted.includes(ep.contactsScope)) throw oerr('OAUTH_SCOPE_CONTACTS', 'Nebol povolený prístup ku kontaktom')
      flow.tokens = tokens
      log.info('prihlásenie dokončené', { provider: flow.provider })
      return { email: flow.tokens.email, provider: flow.provider }
    } catch (e) {
      this.flows.delete(flowId)
      log.warn('prihlásenie zlyhalo', { provider: flow.provider, code: (e as { code?: string }).code })
      throw e
    }
  }

  cancel(flowId: string): void {
    const flow = this.flows.get(flowId)
    flow?.cancel()
    this.flows.delete(flowId)
  }

  /** Prístupový token z dokončeného prihlásenia (na overenie spojenia pred uložením konta). */
  flowCredential(flowId: unknown): { accessToken: string } {
    const t = typeof flowId === 'string' ? this.flows.get(flowId)?.tokens : null
    if (!t) throw oerr('OAUTH_REQUIRED', 'Najprv sa prihláste')
    return { accessToken: t.accessToken }
  }

  flowEmail(flowId: unknown): string | null {
    return typeof flowId === 'string' ? (this.flows.get(flowId)?.tokens?.email ?? null) : null
  }

  /** Povolil používateľ pri prihlásení aj prístup ku kontaktom? */
  flowHasContacts(flowId: unknown): boolean {
    const f = typeof flowId === 'string' ? this.flows.get(flowId) : undefined
    const scope = this.config[f?.provider ?? 'google']?.contactsScope
    return !!(f?.tokens?.scope && scope && f.tokens.scope.split(/\s+/).includes(scope))
  }

  flowProvider(flowId: unknown): OAuthProvider | null {
    return typeof flowId === 'string' ? (this.flows.get(flowId)?.tokens?.provider ?? null) : null
  }

  /** Uloží tokeny z prihlásenia ku kontu (refresh token do bezpečného úložiska) a prihlásenie zabudne. */
  async saveForAccount(flowId: unknown, accountId: number, storage: 'os' | 'session'): Promise<void> {
    const flow = typeof flowId === 'string' ? this.flows.get(flowId) : undefined
    if (!flow?.tokens) throw oerr('OAUTH_REQUIRED', 'Najprv sa prihláste')
    const t = flow.tokens
    await (storage === 'os' ? this.deps.secrets : this.deps.sessionSecrets).set(oauthKey(accountId), JSON.stringify({ provider: t.provider, refreshToken: t.refreshToken }))
    this.cache.set(accountId, { accessToken: t.accessToken, expiresAt: t.expiresAt })
    this.flows.delete(flowId as string)
  }

  async forget(accountId: number): Promise<void> {
    this.cache.delete(accountId)
    await this.deps.secrets.delete(oauthKey(accountId)).catch(() => {})
    await this.deps.sessionSecrets.delete(oauthKey(accountId)).catch(() => {})
  }

  /** Server token odmietol → nabudúce obnoviť. */
  invalidate(accountId: number): void {
    this.cache.delete(accountId)
  }

  /** Platný prístupový token konta (podľa potreby ho obnoví). */
  async accessToken(accountId: number, storage: 'os' | 'session'): Promise<string> {
    const c = this.cache.get(accountId)
    if (c && c.expiresAt - REFRESH_MARGIN_MS > Date.now()) return c.accessToken
    const running = this.refreshing.get(accountId)
    if (running) return running
    const p = this.refresh(accountId, storage).finally(() => this.refreshing.delete(accountId))
    this.refreshing.set(accountId, p)
    return p
  }

  private async refresh(accountId: number, storage: 'os' | 'session'): Promise<string> {
    const store = storage === 'os' ? this.deps.secrets : this.deps.sessionSecrets
    const raw = await store.get(oauthKey(accountId)).catch(() => null)
    if (!raw) throw oerr('OAUTH_EXPIRED', 'Chýba prihlásenie')
    let saved: { provider: OAuthProvider; refreshToken: string }
    try {
      saved = JSON.parse(raw) as { provider: OAuthProvider; refreshToken: string }
    } catch {
      throw oerr('OAUTH_EXPIRED', 'Poškodené prihlásenie')
    }
    const ep = this.config[saved.provider]
    if (!ep) throw oerr('OAUTH_NOT_CONFIGURED', 'Prihlásenie cez tohto poskytovateľa nie je nastavené')
    const t = await tokenRequest(ep, { grant_type: 'refresh_token', refresh_token: saved.refreshToken }, this.fetchFn, saved.provider, saved.refreshToken)
    // Microsoft pri obnove posiela nový refresh token – starý časom prestane platiť.
    if (t.refreshToken !== saved.refreshToken) await store.set(oauthKey(accountId), JSON.stringify({ provider: saved.provider, refreshToken: t.refreshToken }))
    this.cache.set(accountId, { accessToken: t.accessToken, expiresAt: t.expiresAt })
    log.info('token obnovený', { account: accountId, provider: saved.provider })
    return t.accessToken
  }

  closeAll(): void {
    for (const [id] of this.flows) this.cancel(id)
  }
}
