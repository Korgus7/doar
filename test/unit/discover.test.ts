import { describe, it, expect } from 'vitest'
import { discover, emailDomain, baseDomain, certHostCandidates } from '../../src/core/providers/discover'
import { parseAutoconfig } from '../../src/core/providers/autoconfig'
import type { DiscoveryNet, ProbeResult } from '../../src/core/providers/net'

const AUTOCONFIG = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="hosting.sk">
    <incomingServer type="pop3"><hostname>pop.hosting.sk</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
    <incomingServer type="imap">
      <hostname>imap.hosting.sk</hostname><port>143</port><socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.hosting.sk</hostname><port>993</port><socketType>SSL</socketType>
      <username>%EMAILLOCALPART%</username><authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.hosting.sk</hostname><port>25</port><socketType>plain</socketType>
    </outgoingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.hosting.sk</hostname><port>587</port><socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

/** Falošná sieť: nič nefunguje, pokiaľ to test výslovne nepovolí. */
function fakeNet(over: Partial<DiscoveryNet> = {}): DiscoveryNet & { urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    fetchText: async (url) => {
      urls.push(url)
      return over.fetchText ? over.fetchText(url, 0) : null
    },
    resolveSrv: over.resolveSrv ?? (async () => []),
    resolveMx: over.resolveMx ?? (async () => []),
    probe: over.probe ?? (async (): Promise<ProbeResult> => ({ ok: false }))
  }
}

describe('formát autoconfig', () => {
  it('vyberie IMAP s TLS, preskočí POP3 a nešifrované SMTP, doplní meno', () => {
    const r = parseAutoconfig(AUTOCONFIG, 'jan@firma.sk')!
    expect(r.imap).toMatchObject({ host: 'imap.hosting.sk', port: 993, security: 'tls', username: 'jan' })
    expect(r.smtp).toMatchObject({ host: 'smtp.hosting.sk', port: 587, security: 'starttls' })
  })
  it('odmietne nezmyselný obsah', () => {
    expect(parseAutoconfig('<html>404</html>', 'a@b.sk')).toBeNull()
    expect(parseAutoconfig('<clientConfig><incomingServer type="imap"><hostname>evil host;rm</hostname><port>993</port><socketType>SSL</socketType></incomingServer></clientConfig>', 'a@b.sk')).toBeNull()
  })
  it('rozpozná poskytovateľa len s OAuth2', () => {
    const xml = `<clientConfig><incomingServer type="imap"><hostname>imap.x.com</hostname><port>993</port><socketType>SSL</socketType><authentication>OAuth2</authentication></incomingServer></clientConfig>`
    expect(parseAutoconfig(xml, 'a@x.com')!.imap!.oauthOnly).toBe(true)
  })
})

describe('zistenie nastavení', () => {
  it('pomocné funkcie', () => {
    expect(emailDomain(' Jan@Firma.SK ')).toBe('firma.sk')
    expect(emailDomain('bez-zavinaca')).toBeNull()
    expect(baseDomain('mx1.websupport.sk.')).toBe('websupport.sk')
  })

  it('Gmail: známy poskytovateľ, heslo aplikácie, bez kópie do Odoslaných, bez sieťových dotazov', async () => {
    const net = fakeNet()
    const r = await discover('jan@gmail.com', 'Ján', net)
    expect(r.source).toBe('known')
    expect(r.needsAppPassword).toBe(true)
    expect(r.settings.saveSentCopy).toBe(false)
    expect(r.settings.imap.host).toBe('imap.gmail.com')
    expect(net.urls).toEqual([])
  })

  it('Outlook.com: OAuth zatiaľ nepodporujeme – povie to vopred', async () => {
    const r = await discover('jan@outlook.com', '', fakeNet())
    expect(r.unsupportedAuth).toBe('oauth2')
  })

  it('autoconfig na vlastnej doméne má prednosť pred ISPDB', async () => {
    const net = fakeNet({ fetchText: async (u) => (u.startsWith('https://autoconfig.firma.sk/') ? AUTOCONFIG : null) })
    const r = await discover('jan@firma.sk', 'Ján', net)
    expect(r.source).toBe('autoconfig')
    expect(r.settings.imap.host).toBe('imap.hosting.sk')
    expect(net.urls.some((u) => u.includes('thunderbird.net'))).toBe(false)
  })

  it('DNS SRV záznamy (RFC 6186)', async () => {
    const net = fakeNet({
      resolveSrv: async (name) =>
        name === '_imaps._tcp.firma.sk' ? [{ name: 'mail.firma.sk.', port: 993, priority: 0, weight: 0 }] : name === '_submission._tcp.firma.sk' ? [{ name: 'mail.firma.sk', port: 587, priority: 0, weight: 0 }] : []
    })
    const r = await discover('jan@firma.sk', '', net)
    expect(r.source).toBe('srv')
    expect(r.settings.imap).toEqual({ host: 'mail.firma.sk', port: 993, security: 'tls' })
    expect(r.settings.smtp).toEqual({ host: 'mail.firma.sk', port: 587, security: 'starttls' })
  })

  it('vlastná doména u Google (MX) → nastavenia Gmailu', async () => {
    const r = await discover('jan@firma.sk', '', fakeNet({ resolveMx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }] }))
    expect(r.source).toBe('mx')
    expect(r.settings.imap.host).toBe('imap.gmail.com')
  })

  it('MX u hostingu → ISPDB podľa domény hostingu', async () => {
    const net = fakeNet({
      resolveMx: async () => [{ exchange: 'mx2.hosting.sk', priority: 20 }, { exchange: 'mx1.hosting.sk', priority: 10 }],
      fetchText: async (u) => (u === 'https://autoconfig.thunderbird.net/v1.1/hosting.sk' ? AUTOCONFIG : null)
    })
    const r = await discover('jan@firma.sk', '', net)
    expect(r.source).toBe('mx')
    expect(r.settings.imap.host).toBe('imap.hosting.sk')
  })

  it('odhad: certifikát patrí hostingu → navrhne meno z certifikátu', async () => {
    const net = fakeNet({
      probe: async (host, port) => {
        if (host === 'mail.firma.sk' && port === 993) return { ok: false, certHosts: ['*.hosting.sk', 'mail.hosting.sk'] }
        if (host === 'mail.hosting.sk' && port === 993) return { ok: true }
        if (host === 'smtp.firma.sk' && port === 465) return { ok: true }
        return { ok: false }
      }
    })
    const r = await discover('jan@firma.sk', '', net)
    expect(r.source).toBe('guess')
    expect(r.settings.imap).toEqual({ host: 'mail.hosting.sk', port: 993, security: 'tls' })
    expect(r.settings.smtp).toEqual({ host: 'smtp.firma.sk', port: 465, security: 'tls' })
  })

  it('odhad: server z certifikátu (TLS) má prednosť pred STARTTLS bez overeného certifikátu', async () => {
    const net = fakeNet({
      probe: async (host, port) => {
        if (host === 'imap.firma.sk' && port === 993) return { ok: false, certHosts: ['server5.hosting.sk'] }
        if (host === 'imap.firma.sk' && port === 143) return { ok: true }
        if (host === 'server5.hosting.sk' && port === 993) return { ok: true }
        return { ok: false }
      }
    })
    const r = await discover('jan@firma.sk', '', net)
    expect(r.settings.imap).toEqual({ host: 'server5.hosting.sk', port: 993, security: 'tls' })
  })

  it('hosting so zástupným certifikátom (Websupport: *.m1.websupport.sk) → imap./smtp.m1.websupport.sk cez SSL/TLS', async () => {
    // Skutočný prípad z praxe (cami.sk, 2026-10-21): imap.cami.sk má certifikát *.m1.websupport.sk.
    const net = fakeNet({
      probe: async (host, port) => {
        if (host.endsWith('.cami.sk') && (port === 993 || port === 465)) return { ok: false, certHosts: ['*.m1.websupport.sk'] }
        if (host.endsWith('.cami.sk') && (port === 143 || port === 587)) return { ok: true }
        if ((host === 'imap.m1.websupport.sk' && port === 993) || (host === 'smtp.m1.websupport.sk' && port === 465)) return { ok: true }
        return { ok: false }
      }
    })
    const r = await discover('test@cami.sk', '', net)
    expect(r.settings.imap).toEqual({ host: 'imap.m1.websupport.sk', port: 993, security: 'tls' })
    expect(r.settings.smtp).toEqual({ host: 'smtp.m1.websupport.sk', port: 465, security: 'tls' })
  })

  it('zástupné meno sa rozvinie len rozumne', () => {
    expect(certHostCandidates(['*.m1.websupport.sk', 'mail.x.sk', '*.sk'], ['imap', 'mail'])).toEqual(['imap.m1.websupport.sk', 'mail.m1.websupport.sk', 'mail.x.sk'])
  })

  it('nič sa nenašlo → predvyplnený návrh na ručnú úpravu', async () => {
    const r = await discover('jan@firma.sk', 'Ján', fakeNet())
    expect(r.source).toBe('none')
    expect(r.settings).toMatchObject({ email: 'jan@firma.sk', displayName: 'Ján', username: 'jan@firma.sk', imap: { host: 'imap.firma.sk' } })
  })

  it('neplatná adresa', async () => {
    await expect(discover('nie-je-adresa', '', fakeNet())).rejects.toMatchObject({ code: 'INVALID_EMAIL' })
  })
})
