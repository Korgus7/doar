import { ImapFlow } from 'imapflow'
import net from 'node:net'
import type { ServerSettings } from '../../shared/ipc'

/** Vytvorí IMAP klienta s bezpečnými predvoľbami (overenie certifikátu, TLS 1.2+, bez logovania). */
export function createImapClient(s: ServerSettings, user: string, pass: string, opts: { autoIdle?: boolean } = {}): ImapFlow {
  const client = new ImapFlow({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    doSTARTTLS: s.security === 'starttls' ? true : undefined,
    auth: { user, pass },
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
