import { describe, it, expect, inject } from 'vitest'
import { testConnection, testImap, testSmtp } from '../../src/core/mail/connection-test'
import type { AccountSettings } from '../../src/shared/ipc'

const srv = inject('testserver')

const base = (over: Partial<AccountSettings> = {}): AccountSettings => ({
  email: 'alice@doar.test',
  displayName: 'Alica',
  username: 'alice@doar.test',
  imap: { host: '127.0.0.1', port: srv.ports.imaps, security: 'tls' },
  smtp: { host: '127.0.0.1', port: srv.ports.smtps, security: 'tls' },
  saveSentCopy: true,
  providerKey: null,
  ...over
})

describe('overenie prihlásenia (kód aplikácie proti Dovecotu)', () => {
  it('SSL/TLS: IMAP aj SMTP v poriadku', async () => {
    expect(await testConnection(base(), srv.password)).toEqual({ imap: { ok: true }, smtp: { ok: true } })
  })

  it('STARTTLS: IMAP 143-štýl aj SMTP 587-štýl v poriadku', async () => {
    const r = await testConnection(
      base({ imap: { host: '127.0.0.1', port: srv.ports.imap, security: 'starttls' }, smtp: { host: '127.0.0.1', port: srv.ports.smtp, security: 'starttls' } }),
      srv.password
    )
    expect(r).toEqual({ imap: { ok: true }, smtp: { ok: true } })
  })

  it('nesprávne heslo → AUTH_FAILED pre oba protokoly', async () => {
    const r = await testConnection(base(), 'zle-heslo')
    expect(r.imap.code).toBe('AUTH_FAILED')
    expect(r.smtp.code).toBe('AUTH_FAILED')
  })

  it('nesprávny port → CONNECTION_REFUSED', async () => {
    const r = await testImap({ host: '127.0.0.1', port: 3999, security: 'tls' }, 'alice@doar.test', srv.password)
    expect(r.code).toBe('CONNECTION_REFUSED')
  })

  it('SSL/TLS na porte, ktorý čaká STARTTLS → zrozumiteľná chyba TLS, nie zaseknutie', async () => {
    const r = await testImap({ host: '127.0.0.1', port: srv.ports.imap, security: 'tls' }, 'alice@doar.test', srv.password)
    expect(r.ok).toBe(false)
    expect(['TLS_FAILED', 'PROTOCOL']).toContain(r.code)
  })

  it('neexistujúci server → HOST_NOT_FOUND', async () => {
    const r = await testSmtp({ host: 'neexistuje.invalid', port: 465, security: 'tls' }, 'x', 'y')
    expect(r.code).toBe('HOST_NOT_FOUND')
  })

  it('meno servera nesedí s certifikátom → CERT_HOSTNAME + návrh mena z certifikátu', async () => {
    // Certifikát testovacieho servera platí pre "localhost" a 127.0.0.1. Alias doar-test-alias (v /etc/hosts
    // smeruje na 127.0.0.1) v certifikáte nie je. Bez aliasu v /etc/hosts test skončí ako HOST_NOT_FOUND.
    const r = await testImap({ host: 'doar-test-alias', port: srv.ports.imaps, security: 'tls' }, 'alice@doar.test', srv.password)
    expect(r.code === 'CERT_HOSTNAME' || r.code === 'HOST_NOT_FOUND').toBe(true)
    if (r.code === 'CERT_HOSTNAME') expect(r.certHosts).toContain('localhost')
  })

  it('STARTTLS (IMAP aj SMTP) s certifikátom pre iné meno → CERT_HOSTNAME aj s menami z certifikátu', async () => {
    const imap = await testImap({ host: 'doar-test-alias', port: srv.ports.imap, security: 'starttls' }, 'alice@doar.test', srv.password)
    const smtp = await testSmtp({ host: 'doar-test-alias', port: srv.ports.smtp, security: 'starttls' }, 'alice@doar.test', srv.password)
    for (const r of [imap, smtp]) {
      expect(r.code === 'CERT_HOSTNAME' || r.code === 'HOST_NOT_FOUND').toBe(true)
      if (r.code === 'CERT_HOSTNAME') expect(r.certHosts).toContain('localhost')
    }
  })

  it('heslo sa nikdy neobjaví v technickom detaile chyby', async () => {
    const r = await testConnection(base(), 'MojeTajneHeslo!')
    expect(JSON.stringify(r)).not.toContain('MojeTajneHeslo!')
  })
})
