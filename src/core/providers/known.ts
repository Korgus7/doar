import type { OAuthProvider, ServerSettings } from '../../shared/ipc'

/**
 * Známi poskytovatelia. Len overené údaje; ostatných nájde automatické zisťovanie.
 * saveSentCopy = false → server si odoslanú správu do Odoslaných ukladá sám.
 */
export interface KnownProvider {
  key: string
  name: string
  domains: string[]
  /** Prípony MX záznamov, podľa ktorých spoznáme vlastnú doménu u tohto poskytovateľa. */
  mxSuffixes: string[]
  imap: ServerSettings
  smtp: ServerSettings
  saveSentCopy: boolean
  /** Bežné heslo nefunguje – treba heslo aplikácie. */
  needsAppPassword: boolean
  /** Heslom sa prihlásiť nedá vôbec. */
  unsupportedAuth: 'oauth2' | null
  /** Prihlásenie cez účet poskytovateľa (OAuth), ak ho Doar Mail má nastavené. */
  oauth: OAuthProvider | null
}

export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
  {
    key: 'gmail',
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    mxSuffixes: ['google.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    saveSentCopy: false,
    needsAppPassword: true,
    unsupportedAuth: null,
    oauth: 'google'
  },
  {
    key: 'microsoft',
    name: 'Outlook.com / Microsoft 365',
    domains: ['outlook.com', 'outlook.sk', 'outlook.cz', 'hotmail.com', 'hotmail.sk', 'live.com', 'msn.com'],
    mxSuffixes: ['mail.protection.outlook.com', 'olc.protection.outlook.com'],
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
    saveSentCopy: false,
    needsAppPassword: false,
    unsupportedAuth: 'oauth2',
    oauth: 'microsoft'
  }
]

export function knownByDomain(domain: string): KnownProvider | null {
  const d = domain.toLowerCase()
  return KNOWN_PROVIDERS.find((p) => p.domains.includes(d)) ?? null
}

export function knownByMx(mxHost: string): KnownProvider | null {
  const h = mxHost.toLowerCase().replace(/\.$/, '')
  return KNOWN_PROVIDERS.find((p) => p.mxSuffixes.some((s) => h === s || h.endsWith(`.${s}`))) ?? null
}
