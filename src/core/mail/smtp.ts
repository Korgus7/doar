import SMTPConnection from 'nodemailer/lib/smtp-connection'
import net from 'node:net'
import type { ServerSettings } from '../../shared/ipc'
import { classifyError } from './connection-test'
import type { Credential } from './imap'

/** Prihlásenie na SMTP: heslo, alebo XOAUTH2 s prístupovým tokenom. */
export function smtpLogin(user: string, cred: Credential): Parameters<SMTPConnection['login']>[0] {
  if (typeof cred === 'string') return { user, pass: cred }
  const token = cred.accessToken
  return {
    user,
    method: 'XOAUTH2',
    oauth2: {
      getToken: (_retry: boolean, cb: (e: Error | null, t?: string) => void) => cb(null, token),
      buildXOAuth2Token: (t: string) => Buffer.from(`user=${user}\x01auth=Bearer ${t}\x01\x01`).toString('base64')
    }
  } as unknown as Parameters<SMTPConnection['login']>[0]
}

/**
 * Odoslanie hotovej správy cez SMTP so sledovaním fázy.
 *
 * Knižnica pri prerušení spojenia hlási rovnakú chybu, či sa spojenie prerušilo pred pripojením,
 * alebo až po odoslaní obsahu – vtedy správa mohla byť doručená. Preto fázy sledujeme sami:
 *  - chyba pri pripájaní alebo prihlásení → správa určite NEODIŠLA (bezpečné zopakovať),
 *  - server odpovedal kódom chyby (4xx/5xx) → NEODIŠLA,
 *  - spojenie sa prerušilo počas odosielania bez odpovede → NEJASNÝ výsledok (nikdy neopakovať automaticky).
 */
export type SendOutcome =
  | { status: 'sent'; response: string; accepted: string[]; rejected: string[] }
  | { status: 'failed'; code: string; detail: string; responseCode?: number }
  | { status: 'uncertain'; detail: string }

const TIMEOUT = 30_000

export function sendRaw(s: ServerSettings, user: string, cred: Credential, envelope: { from: string; to: string[] }, raw: Buffer): Promise<SendOutcome> {
  return new Promise((resolve) => {
    let phase: 'connect' | 'login' | 'send' | 'done' = 'connect'
    let settled = false
    const conn = new SMTPConnection({
      host: s.host,
      port: s.port,
      secure: s.security === 'tls',
      requireTLS: s.security === 'starttls',
      tls: { ...(net.isIP(s.host) ? {} : { servername: s.host }), minVersion: 'TLSv1.2' },
      connectionTimeout: TIMEOUT,
      greetingTimeout: TIMEOUT,
      socketTimeout: TIMEOUT * 4,
      logger: false
    })
    const finish = (o: SendOutcome): void => {
      if (settled) return
      settled = true
      phase = 'done'
      try {
        if (o.status === 'sent') conn.quit()
        else conn.close()
      } catch {
        /* ignorovať */
      }
      resolve(o)
    }
    const fail = (e: unknown): void => {
      const err = e as { responseCode?: number; message?: string }
      const detail = String(err?.message ?? e).slice(0, 300)
      if (phase === 'send') {
        if (typeof err?.responseCode === 'number' && err.responseCode >= 400) {
          finish({ status: 'failed', code: 'REJECTED', detail, responseCode: err.responseCode })
        } else {
          finish({ status: 'uncertain', detail })
        }
      } else {
        finish({ status: 'failed', code: classifyError(e).code ?? 'UNKNOWN', detail })
      }
    }
    conn.on('error', fail)
    conn.connect((err) => {
      if (err) return fail(err)
      phase = 'login'
      conn.login(smtpLogin(user, cred), (err2) => {
        if (err2) return fail(err2)
        phase = 'send'
        conn.send(envelope, raw, (err3, info) => {
          if (err3) return fail(err3)
          finish({ status: 'sent', response: info.response, accepted: info.accepted.map(String), rejected: info.rejected.map(String) })
        })
      })
    })
  })
}
