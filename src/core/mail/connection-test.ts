import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import net from 'node:net'
import type { AccountSettings, ConnectionErrorCode, ConnectionTestResult, ProtocolTestResult, ServerSettings } from '../../shared/ipc'
import { certNames, peekCertHosts } from '../providers/net'
import { logger } from '../log'
import { imapAuth, type Credential } from './imap'

const log = logger('conn-test')
const TIMEOUT = 15_000

type AnyErr = Error & {
  code?: string
  authenticationFailed?: boolean
  serverResponseCode?: string
  responseCode?: number
  command?: string
  cert?: unknown
  reason?: string
  cause?: unknown
}

/** Prevedie chybu z imapflow / nodemailer / Node.js na zrozumiteľný kód. */
export function classifyError(e: unknown): ProtocolTestResult {
  const errs: AnyErr[] = []
  let cur: unknown = e
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    errs.push(cur as AnyErr)
    cur = (cur as AnyErr).cause
  }
  const codes = errs.map((x) => String(x.code ?? '')).filter(Boolean)
  const text = errs.map((x) => `${x.message ?? ''} ${x.reason ?? ''}`).join(' ')
  const has = (...c: string[]): boolean => codes.some((x) => c.includes(x))
  const detail = (errs[0]?.message ?? String(e)).slice(0, 300)
  const r = (code: ConnectionErrorCode, extra: Partial<ProtocolTestResult> = {}): ProtocolTestResult => ({ ok: false, code, detail, ...extra })

  if (has('ERR_TLS_CERT_ALTNAME_INVALID') || /does not match certificate|altnames/i.test(text)) {
    const certErr = errs.find((x) => x.cert)
    return r('CERT_HOSTNAME', { certHosts: certNames(certErr?.cert as Parameters<typeof certNames>[0]) })
  }
  if (has('CERT_HAS_EXPIRED') || /certificate has expired/i.test(text)) return r('CERT_EXPIRED')
  if (
    has('DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED') ||
    /self[- ]signed certificate|unable to verify|unable to get local issuer/i.test(text)
  )
    return r('CERT_UNTRUSTED')
  if (errs.some((x) => x.authenticationFailed) || has('EAUTH') || errs.some((x) => x.serverResponseCode === 'AUTHENTICATIONFAILED') || errs.some((x) => x.responseCode === 535) || /authentication failed|invalid credentials|AUTHENTICATIONFAILED/i.test(text))
    return r('AUTH_FAILED')
  if (has('ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN')) return r('NO_NETWORK')
  if (has('ENOTFOUND', 'EAI_AGAIN', 'EDNS') || /getaddrinfo/i.test(text)) return r('HOST_NOT_FOUND')
  if (has('ECONNREFUSED')) return r('CONNECTION_REFUSED')
  if (has('ETIMEDOUT', 'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'ESOCKETTIMEDOUT') || /timed? ?out/i.test(text)) return r('TIMEOUT')
  if (/STARTTLS/i.test(text) && /not (supported|advertised)|unsupported|failed/i.test(text)) return r('STARTTLS_UNSUPPORTED')
  if (has('ERR_SSL_WRONG_VERSION_NUMBER', 'EPROTO', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'ETLS') || /wrong version number|ssl routines|tls/i.test(text)) return r('TLS_FAILED')
  if (has('ECONNRESET', 'EPIPE', 'ESOCKET', 'EPROTOCOL', 'NoConnection', 'EENVELOPE')) return r('PROTOCOL')
  return r('UNKNOWN')
}

function tlsOptions(s: ServerSettings): { servername?: string; minVersion: 'TLSv1.2' } {
  // SNI sa posiela len pre mená, nie pre IP adresy.
  return { ...(net.isIP(s.host) ? {} : { servername: s.host }), minVersion: 'TLSv1.2' }
}

/** Pri nesúlade mena doplní mená z certifikátu, ak ich chyba knižnice neobsahovala (typicky pri STARTTLS). */
async function withCertHosts(r: ProtocolTestResult, s: ServerSettings, protocol: 'imap' | 'smtp'): Promise<ProtocolTestResult> {
  if (r.code !== 'CERT_HOSTNAME' || r.certHosts?.length) return r
  const names = await peekCertHosts(s.host, s.port, s.security, protocol)
  return names.length ? { ...r, certHosts: names } : r
}

export async function testImap(s: ServerSettings, user: string, cred: Credential): Promise<ProtocolTestResult> {
  const client = new ImapFlow({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    doSTARTTLS: s.security === 'starttls' ? true : undefined,
    auth: imapAuth(user, cred),
    tls: tlsOptions(s),
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: TIMEOUT,
    greetingTimeout: TIMEOUT,
    socketTimeout: TIMEOUT * 2
  })
  client.on('error', () => {
    /* chybu spracujeme cez connect() */
  })
  try {
    await client.connect()
    await client.logout()
    return { ok: true }
  } catch (e) {
    const r = await withCertHosts(classifyError(e), s, 'imap')
    log.info('IMAP test zlyhal', { host: s.host, port: s.port, security: s.security, code: r.code })
    return r
  } finally {
    client.close()
  }
}

export async function testSmtp(s: ServerSettings, user: string, cred: Credential): Promise<ProtocolTestResult> {
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    auth: typeof cred === 'string' ? { user, pass: cred } : { type: 'OAuth2', user, accessToken: cred.accessToken },
    tls: tlsOptions(s),
    connectionTimeout: TIMEOUT,
    greetingTimeout: TIMEOUT,
    socketTimeout: TIMEOUT * 2,
    logger: false
  })
  try {
    await transport.verify()
    return { ok: true }
  } catch (e) {
    const r = await withCertHosts(classifyError(e), s, 'smtp')
    log.info('SMTP test zlyhal', { host: s.host, port: s.port, security: s.security, code: r.code })
    return r
  } finally {
    transport.close()
  }
}

export async function testConnection(settings: AccountSettings, password: Credential): Promise<ConnectionTestResult> {
  const [imap, smtp] = await Promise.all([
    testImap(settings.imap, settings.username, password),
    testSmtp(settings.smtp, settings.username, password)
  ])
  return { imap, smtp }
}
