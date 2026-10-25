import { ImapFlow } from 'imapflow'
import net from 'node:net'
import type { ServerSettings } from '../../shared/ipc'

/** Prihlasovací údaj: heslo, alebo prístupový token z prihlásenia cez účet poskytovateľa (XOAUTH2/OAUTHBEARER). */
export type Credential = string | { accessToken: string }

export function imapAuth(user: string, cred: Credential): { user: string; pass: string } | { user: string; accessToken: string } {
  return typeof cred === 'string' ? { user, pass: cred } : { user, accessToken: cred.accessToken }
}

/** Vytvorí IMAP klienta s bezpečnými predvoľbami (overenie certifikátu, TLS 1.2+, bez logovania). */
export function createImapClient(s: ServerSettings, user: string, cred: Credential, opts: { autoIdle?: boolean } = {}): ImapFlow {
  const client = new ImapFlow({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    doSTARTTLS: s.security === 'starttls' ? true : undefined,
    auth: imapAuth(user, cred),
    tls: { ...(net.isIP(s.host) ? {} : { servername: s.host }), minVersion: 'TLSv1.2' },
    logger: false,
    emitLogs: false,
    disableAutoIdle: !opts.autoIdle,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 5 * 60_000
  })
  // Chyby spojenia spracúva volajúci (connect/udalosť close); bez poslucháča by Node proces zhodil.
  client.on('error', () => {})
  return client
}
