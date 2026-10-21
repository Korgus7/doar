import type { Security, ServerSettings } from '../../shared/ipc'

/**
 * Spracovanie formátu Mozilla autoconfig (config-v1.1.xml).
 * Používa ho Thunderbird ISPDB aj mnohí poskytovatelia na vlastnej doméne.
 * Zámerne jednoduchý parser bez závislostí – berieme len pár polí.
 */
export interface AutoconfigServer extends ServerSettings {
  username: string
  /** Server podporuje len OAuth2 (heslo nefunguje). */
  oauthOnly: boolean
}

export interface AutoconfigResult {
  imap: AutoconfigServer | null
  smtp: AutoconfigServer | null
}

function tag(block: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'gi')
  for (const m of block.matchAll(re)) out.push(decodeXml(m[1] ?? ''))
  return out
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function socketToSecurity(socketType: string): Security | null {
  const s = socketType.toUpperCase()
  if (s === 'SSL' || s === 'TLS') return 'tls'
  if (s === 'STARTTLS') return 'starttls'
  return null // "plain" – nešifrované spojenie nepoužívame
}

function expandUsername(template: string, email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return template
    .replace(/%EMAILADDRESS%/g, email)
    .replace(/%EMAILLOCALPART%/g, local)
    .replace(/%EMAILDOMAIN%/g, domain)
}

function parseServers(xml: string, element: 'incomingServer' | 'outgoingServer', type: string, email: string): AutoconfigServer | null {
  const re = new RegExp(`<${element}\\b[^>]*\\btype\\s*=\\s*["']${type}["'][^>]*>([\\s\\S]*?)</${element}>`, 'gi')
  const candidates: AutoconfigServer[] = []
  for (const m of xml.matchAll(re)) {
    const block = m[1] ?? ''
    const host = tag(block, 'hostname')[0]
    const port = Number(tag(block, 'port')[0])
    const security = socketToSecurity(tag(block, 'socketType')[0] ?? '')
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535 || !security) continue
    if (!/^[a-z0-9.-]+$/i.test(host)) continue
    const auth = tag(block, 'authentication').map((a) => a.toLowerCase())
    const passwordOk = auth.length === 0 || auth.some((a) => a.startsWith('password'))
    candidates.push({
      host: host.toLowerCase(),
      port,
      security,
      username: expandUsername(tag(block, 'username')[0] ?? '%EMAILADDRESS%', email),
      oauthOnly: !passwordOk && auth.includes('oauth2')
    })
  }
  // Prednosť má priame TLS, potom STARTTLS; inak poradie podľa súboru.
  candidates.sort((a, b) => (a.security === b.security ? 0 : a.security === 'tls' ? -1 : 1))
  return candidates[0] ?? null
}

export function parseAutoconfig(xml: string, email: string): AutoconfigResult | null {
  if (!/<clientConfig\b/i.test(xml)) return null
  const imap = parseServers(xml, 'incomingServer', 'imap', email)
  const smtp = parseServers(xml, 'outgoingServer', 'smtp', email)
  if (!imap && !smtp) return null
  return { imap, smtp }
}
