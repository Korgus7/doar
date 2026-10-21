import type { AccountSettings, DiscoveryResult, DiscoverySource, ServerSettings } from '../../shared/ipc'
import { parseAutoconfig, type AutoconfigResult } from './autoconfig'
import { knownByDomain, knownByMx, type KnownProvider } from './known'
import type { DiscoveryNet } from './net'

/**
 * Zistenie nastavení servera podľa e-mailovej adresy.
 * Poradie (najprv zdroje samotnej domény, až potom externé):
 *  1. známi poskytovatelia
 *  2. autoconfig na doméne (HTTPS) a DNS SRV záznamy (RFC 6186)
 *  3. databáza Mozilla ISPDB
 *  4. MX záznamy (vlastná doména u Google/Microsoft alebo u hostingu z ISPDB)
 *  5. odhad (imap./mail./smtp. + doména) overený sondou na porte
 * Výsledok je vždy len návrh – používateľ ho vidí a môže upraviť.
 */

const HTTP_TIMEOUT = 6000
const PROBE_TIMEOUT = 5000

export function emailDomain(email: string): string | null {
  const m = email.trim().toLowerCase().match(/^[^\s@]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/)
  return m?.[1] ?? null
}

function base(email: string, displayName: string): Omit<AccountSettings, 'imap' | 'smtp'> {
  return { email: email.trim(), displayName: displayName.trim(), username: email.trim(), saveSentCopy: true, providerKey: null }
}

function fromKnown(p: KnownProvider, email: string, displayName: string): DiscoveryResult {
  return {
    settings: { ...base(email, displayName), imap: { ...p.imap }, smtp: { ...p.smtp }, saveSentCopy: p.saveSentCopy, providerKey: p.key },
    source: 'known',
    unsupportedAuth: p.unsupportedAuth,
    needsAppPassword: p.needsAppPassword
  }
}

function fromAutoconfig(a: AutoconfigResult, email: string, displayName: string, source: DiscoverySource, domain: string): DiscoveryResult | null {
  if (!a.imap) return null
  const smtp: ServerSettings = a.smtp ? { host: a.smtp.host, port: a.smtp.port, security: a.smtp.security } : { host: `smtp.${domain}`, port: 465, security: 'tls' }
  return {
    settings: {
      ...base(email, displayName),
      username: a.imap.username || email.trim(),
      imap: { host: a.imap.host, port: a.imap.port, security: a.imap.security },
      smtp
    },
    source,
    unsupportedAuth: a.imap.oauthOnly ? 'oauth2' : null,
    needsAppPassword: false
  }
}

async function tryAutoconfigUrls(urls: string[], email: string, n: DiscoveryNet): Promise<AutoconfigResult | null> {
  const results = await Promise.all(urls.map((u) => n.fetchText(u, HTTP_TIMEOUT)))
  for (const xml of results) {
    if (!xml) continue
    const parsed = parseAutoconfig(xml, email)
    if (parsed?.imap) return parsed
  }
  return null
}

async function srv(domain: string, n: DiscoveryNet): Promise<{ imap: ServerSettings | null; smtp: ServerSettings | null }> {
  const pick = async (name: string, security: ServerSettings['security']): Promise<ServerSettings | null> => {
    const recs = (await n.resolveSrv(name)).filter((r) => r.name && r.name !== '.' && r.port > 0)
    recs.sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    const r = recs[0]
    return r ? { host: r.name.toLowerCase().replace(/\.$/, ''), port: r.port, security } : null
  }
  const [imaps, imap, submissions, submission] = await Promise.all([
    pick(`_imaps._tcp.${domain}`, 'tls'),
    pick(`_imap._tcp.${domain}`, 'starttls'),
    pick(`_submissions._tcp.${domain}`, 'tls'),
    pick(`_submission._tcp.${domain}`, 'starttls')
  ])
  return { imap: imaps ?? imap, smtp: submissions ?? submission }
}

/**
 * Mená serverov odvodené z certifikátu: konkrétne mená priamo, zástupné (*.x.sk) rozvinuté
 * na prefix.x.sk. Zástupné meno musí mať aspoň 3 časti (nie *.sk).
 */
export function certHostCandidates(certHosts: string[], prefixes: string[]): string[] {
  const out: string[] = []
  for (const h of certHosts) {
    if (!h.includes('*')) out.push(h)
    else if (/^\*\.[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) for (const p of prefixes) out.push(`${p}.${h.slice(2)}`)
  }
  return [...new Set(out)]
}

/** Registrovateľná doména z mena servera (zjednodušene posledné dve časti). */
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.')
  return parts.slice(-2).join('.')
}

async function guess(domain: string, n: DiscoveryNet): Promise<{ imap: ServerSettings | null; smtp: ServerSettings | null }> {
  const imapCandidates: ServerSettings[] = []
  for (const h of [`imap.${domain}`, `mail.${domain}`, domain]) {
    imapCandidates.push({ host: h, port: 993, security: 'tls' }, { host: h, port: 143, security: 'starttls' })
  }
  const smtpCandidates: ServerSettings[] = []
  for (const h of [`smtp.${domain}`, `mail.${domain}`, domain]) {
    smtpCandidates.push({ host: h, port: 465, security: 'tls' }, { host: h, port: 587, security: 'starttls' })
  }

  const firstWorking = async (cands: ServerSettings[], prefixes: string[]): Promise<ServerSettings | null> => {
    const results = await Promise.all(cands.map((c) => n.probe(c.host, c.port, c.security, PROBE_TIMEOUT)))
    // 1. Priame TLS s platným certifikátom (sonda ho overila).
    for (const [i, r] of results.entries()) if (r.ok && cands[i]!.security === 'tls') return cands[i]!
    // 2. Certifikát patrí inému menu (typické pri hostingu) – skúsime mená z certifikátu.
    //    Zástupné meno *.m1.hosting.sk rozvinieme na imap./mail./smtp.m1.hosting.sk.
    const tried = new Set<string>()
    for (const [i, r] of results.entries()) {
      const c = cands[i]!
      for (const name of certHostCandidates(r.certHosts ?? [], prefixes)) {
        const key = `${name}:${c.port}`
        if (tried.has(key)) continue
        tried.add(key)
        if ((await n.probe(name, c.port, c.security, PROBE_TIMEOUT)).ok) return { ...c, host: name }
      }
    }
    // 3. STARTTLS – server odpovedal (certifikát overí až test prihlásenia).
    for (const [i, r] of results.entries()) if (r.ok) return cands[i]!
    return null
  }
  const [imap, smtp] = await Promise.all([firstWorking(imapCandidates, ['imap', 'mail']), firstWorking(smtpCandidates, ['smtp', 'mail'])])
  return { imap, smtp }
}

export async function discover(email: string, displayName: string, n: DiscoveryNet): Promise<DiscoveryResult> {
  const domain = emailDomain(email)
  const fallback = (d: string): DiscoveryResult => ({
    settings: { ...base(email, displayName), imap: { host: `imap.${d}`, port: 993, security: 'tls' }, smtp: { host: `smtp.${d}`, port: 465, security: 'tls' } },
    source: 'none',
    unsupportedAuth: null,
    needsAppPassword: false
  })
  if (!domain) throw Object.assign(new Error('Neplatná e-mailová adresa'), { code: 'INVALID_EMAIL' })

  // 1. známi poskytovatelia
  const known = knownByDomain(domain)
  if (known) return fromKnown(known, email, displayName)

  // 2. autoconfig domény + SRV (paralelne)
  const enc = encodeURIComponent(email.trim())
  const [domainConfig, srvResult] = await Promise.all([
    tryAutoconfigUrls(
      [`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${enc}`, `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${enc}`],
      email,
      n
    ),
    srv(domain, n)
  ])
  if (domainConfig) {
    const r = fromAutoconfig(domainConfig, email, displayName, 'autoconfig', domain)
    if (r) return r
  }
  if (srvResult.imap) {
    return {
      settings: { ...base(email, displayName), imap: srvResult.imap, smtp: srvResult.smtp ?? { host: srvResult.imap.host, port: 465, security: 'tls' } },
      source: 'srv',
      unsupportedAuth: null,
      needsAppPassword: false
    }
  }

  // 3. Mozilla ISPDB
  const ispdb = await tryAutoconfigUrls([`https://autoconfig.thunderbird.net/v1.1/${domain}`], email, n)
  if (ispdb) {
    const r = fromAutoconfig(ispdb, email, displayName, 'ispdb', domain)
    if (r) return r
  }

  // 4. MX
  const mx = (await n.resolveMx(domain)).sort((a, b) => a.priority - b.priority)[0]
  if (mx) {
    const byMx = knownByMx(mx.exchange)
    if (byMx) {
      const r = fromKnown(byMx, email, displayName)
      return { ...r, source: 'mx' }
    }
    const mxBase = baseDomain(mx.exchange)
    if (mxBase !== domain) {
      const mxConf = await tryAutoconfigUrls([`https://autoconfig.thunderbird.net/v1.1/${mxBase}`], email, n)
      if (mxConf) {
        const r = fromAutoconfig(mxConf, email, displayName, 'mx', domain)
        if (r) return r
      }
    }
  }

  // 5. odhad overený sondou
  const g = await guess(domain, n)
  if (g.imap) {
    return {
      settings: { ...base(email, displayName), imap: g.imap, smtp: g.smtp ?? { host: g.imap.host, port: 465, security: 'tls' } },
      source: 'guess',
      unsupportedAuth: null,
      needsAppPassword: false
    }
  }
  return fallback(domain)
}
