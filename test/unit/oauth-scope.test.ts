import { describe, it, expect } from 'vitest'
import { OAuthService, type OAuthConfig, type FetchFn } from '../../src/core/oauth/oauth'
import { MemorySecrets } from '../../src/core/secrets'

const google = (): OAuthConfig => ({
  microsoft: null,
  google: {
    authUrl: 'https://accounts.example/auth',
    tokenUrl: 'https://accounts.example/token',
    scope: 'openid email https://mail.google.com/',
    clientId: 'c',
    clientSecret: 's',
    scopeOnToken: false,
    extraAuth: {},
    redirectHost: '127.0.0.1',
    contactsScope: 'https://www.googleapis.com/auth/carddav',
    mailScope: 'https://mail.google.com/'
  }
})

/** Prihlásenie s odpoveďou servera, ktorá udelí dané rozsahy (prehliadač nahradí priama požiadavka na spätné volanie). */
let last: { oauth: OAuthService; flowId: string } | null = null

async function signIn(scope: string | undefined, contacts = false): Promise<unknown> {
  const fetchFn: FetchFn = async () =>
    new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, ...(scope !== undefined ? { scope } : {}) }), { status: 200 })
  const oauth = new OAuthService({ secrets: new MemorySecrets(true), sessionSecrets: new MemorySecrets(), config: google(), fetch: fetchFn })
  const { flowId, url } = await oauth.start({ provider: 'google', contacts })
  last = { oauth, flowId }
  const u = new URL(url)
  const back = new URL(u.searchParams.get('redirect_uri')!)
  back.searchParams.set('state', u.searchParams.get('state')!)
  back.searchParams.set('code', 'kod')
  await fetch(back)
  return oauth.finish(flowId).then(() => 'ok', (e: { code?: string }) => e.code)
}

describe('prihlásenie cez Google: odškrtnuté prístupy na stránke súhlasu', () => {
  it('bez prístupu k pošte → OAUTH_SCOPE_MAIL; s ním v poriadku; bez údaja o rozsahoch sa nekontroluje', async () => {
    expect(await signIn('openid email')).toBe('OAUTH_SCOPE_MAIL')
    expect(await signIn('https://mail.google.com/ openid email')).toBe('ok')
    expect(await signIn(undefined)).toBe('ok')
  })

  it('pri zapínaní kontaktov: bez prístupu ku kontaktom → OAUTH_SCOPE_CONTACTS', async () => {
    expect(await signIn('https://mail.google.com/ openid', true)).toBe('OAUTH_SCOPE_CONTACTS')
    expect(await signIn('https://mail.google.com/ https://www.googleapis.com/auth/carddav', true)).toBe('ok')
    expect(await signIn('https://www.googleapis.com/auth/carddav', true)).toBe('OAUTH_SCOPE_MAIL')
  })

  it('flowHasContacts: či prihlásenie povolilo aj kontakty (pre automatické zapnutie synchronizácie)', async () => {
    expect(await signIn('https://mail.google.com/ https://www.googleapis.com/auth/carddav', true)).toBe('ok')
    expect(last!.oauth.flowHasContacts(last!.flowId)).toBe(true)
    expect(await signIn('https://mail.google.com/', false)).toBe('ok')
    expect(last!.oauth.flowHasContacts(last!.flowId)).toBe(false)
  })
})
