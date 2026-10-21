import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../../src/core/store/db'
import { addAccount, listAccounts, validateSettings } from '../../src/core/accounts'
import { MemorySecrets, passwordKey } from '../../src/core/secrets'
import { classifyError } from '../../src/core/mail/connection-test'
import type { AccountSettings } from '../../src/shared/ipc'

const settings: AccountSettings = {
  email: 'jan@firma.sk',
  displayName: 'Ján Novák',
  username: 'jan@firma.sk',
  imap: { host: 'mail.firma.sk', port: 993, security: 'tls' },
  smtp: { host: 'mail.firma.sk', port: 465, security: 'tls' },
  saveSentCopy: true,
  providerKey: null
}

let db: Db
beforeEach(() => {
  db = openDb(':memory:')
})

describe('kontá', () => {
  it('uloží konto, heslo ide do úložiska tajomstiev, nie do databázy', async () => {
    const secrets = new MemorySecrets(true)
    const acc = await addAccount(db, secrets, new MemorySecrets(), { settings, password: 'TajneHeslo123', rememberPassword: true })
    expect(acc).toMatchObject({ email: 'jan@firma.sk', name: 'firma.sk' })
    expect(await secrets.get(passwordKey(acc.id))).toBe('TajneHeslo123')
    const dump = JSON.stringify(db.prepare('SELECT * FROM accounts').all())
    expect(dump).not.toContain('TajneHeslo123')
    expect(listAccounts(db)).toHaveLength(1)
  })

  it('bez bezpečného úložiska nič neuloží potichu – vyžiada si súhlas', async () => {
    await expect(addAccount(db, new MemorySecrets(false), new MemorySecrets(), { settings, password: 'x', rememberPassword: true })).rejects.toMatchObject({
      code: 'SECURE_STORAGE_UNAVAILABLE'
    })
    expect(listAccounts(db)).toHaveLength(0)
  })

  it('heslo len do zatvorenia aplikácie', async () => {
    const os = new MemorySecrets(false)
    const session = new MemorySecrets()
    const acc = await addAccount(db, os, session, { settings, password: 'x', rememberPassword: false })
    expect(await session.get(passwordKey(acc.id))).toBe('x')
    expect(await os.get(passwordKey(acc.id))).toBeNull()
    expect((db.prepare('SELECT password_storage FROM accounts').get() as { password_storage: string }).password_storage).toBe('session')
  })

  it('to isté konto dvakrát nepridá', async () => {
    const s = new MemorySecrets()
    await addAccount(db, s, s, { settings, password: 'x', rememberPassword: true })
    await expect(addAccount(db, s, s, { settings: { ...settings, email: 'JAN@firma.sk' }, password: 'x', rememberPassword: true })).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' })
  })

  it('ak sa heslo nepodarí uložiť, konto nevznikne', async () => {
    const broken = new MemorySecrets(true)
    broken.set = async () => {
      throw new Error('disk')
    }
    await expect(addAccount(db, broken, broken, { settings, password: 'x', rememberPassword: true })).rejects.toMatchObject({ code: 'SECRET_SAVE_FAILED' })
    expect(listAccounts(db)).toHaveLength(0)
  })

  it('validácia odmietne nebezpečné alebo nezmyselné hodnoty z rozhrania', () => {
    expect(() => validateSettings({ ...settings, imap: { host: 'mail.firma.sk; rm -rf', port: 993, security: 'tls' } })).toThrow()
    expect(() => validateSettings({ ...settings, smtp: { host: 'smtp.firma.sk', port: 70000, security: 'tls' } })).toThrow()
    expect(() => validateSettings({ ...settings, imap: { host: 'x.sk', port: 143, security: 'plain' } })).toThrow()
    expect(validateSettings({ ...settings, imap: { host: '127.0.0.1', port: 993, security: 'tls' } }).imap.host).toBe('127.0.0.1')
    expect(validateSettings({ ...settings, username: '  ' }).username).toBe('jan@firma.sk')
  })
})

describe('zrozumiteľné chyby spojenia', () => {
  const e = (props: Record<string, unknown>, msg = 'x') => Object.assign(new Error(msg), props)
  it.each([
    [e({ authenticationFailed: true }), 'AUTH_FAILED'],
    [e({ code: 'EAUTH', responseCode: 535 }), 'AUTH_FAILED'],
    [e({ code: 'ENOTFOUND' }, 'getaddrinfo ENOTFOUND imap.x.sk'), 'HOST_NOT_FOUND'],
    [e({ code: 'ECONNREFUSED' }), 'CONNECTION_REFUSED'],
    [e({ code: 'ETIMEDOUT' }), 'TIMEOUT'],
    [e({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'self-signed certificate'), 'CERT_UNTRUSTED'],
    [e({ code: 'CERT_HAS_EXPIRED' }), 'CERT_EXPIRED'],
    [e({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' }), 'TLS_FAILED'],
    [e({ code: 'ESOCKET', cause: e({ code: 'ECONNREFUSED' }) }), 'CONNECTION_REFUSED']
  ])('%#: %s', (err, code) => {
    expect(classifyError(err).code).toBe(code)
  })

  it('nesúlad mena v certifikáte vráti mená, pre ktoré certifikát platí', () => {
    const err = e({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', cert: { subject: { CN: 'mail.hosting.sk' }, subjectaltname: 'DNS:mail.hosting.sk, DNS:*.hosting.sk' } })
    expect(classifyError(err)).toMatchObject({ code: 'CERT_HOSTNAME', certHosts: ['mail.hosting.sk', '*.hosting.sk'] })
  })
})
