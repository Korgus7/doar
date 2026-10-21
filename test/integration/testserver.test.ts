import { describe, it, expect, inject } from 'vitest'
import { readFileSync } from 'node:fs'
import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import nodemailer from 'nodemailer'

const p = inject('testserver')
const srv = { ...p, ca: readFileSync(p.caPath), user: (n: string) => `${n}@doar.test` }

const imap = (name: string, opts: Partial<ImapFlowOptions> = {}) =>
  new ImapFlow({
    host: srv.host,
    port: srv.ports.imaps,
    secure: true,
    auth: { user: srv.user(name), pass: srv.password },
    tls: { ca: srv.ca },
    logger: false,
    ...opts
  })

const smtp = (name: string) =>
  nodemailer.createTransport({
    host: srv.host,
    port: srv.ports.smtps,
    secure: true,
    auth: { user: srv.user(name), pass: srv.password },
    tls: { ca: srv.ca }
  })

describe('testovací poštový server', () => {
  it('odoslanie cez SMTP a príjem cez IMAP (Unicode predmet)', async () => {
    const info = await smtp('alice').sendMail({
      from: srv.user('alice'),
      to: srv.user('bob'),
      subject: 'Faktúra – žltý kôň',
      text: 'Príliš žluťoučký kůň úpěl ďábelské ódy.'
    })
    expect(info.response).toMatch(/^250/)

    const c = imap('bob')
    await c.connect()
    const lock = await c.getMailboxLock('INBOX')
    const subjects: string[] = []
    for await (const m of c.fetch('1:*', { envelope: true })) subjects.push(m.envelope?.subject ?? '')
    lock.release()
    await c.logout()
    expect(subjects).toContain('Faktúra – žltý kôň')
  })

  it('server ohlasuje špeciálne priečinky a potrebné rozšírenia', async () => {
    const c = imap('alice')
    await c.connect()
    const special = Object.fromEntries((await c.list()).filter((f) => f.specialUse).map((f) => [f.specialUse, f.path]))
    for (const cap of ['IDLE', 'UIDPLUS', 'CONDSTORE', 'QRESYNC', 'MOVE', 'SPECIAL-USE']) expect(c.capabilities.has(cap), cap).toBe(true)
    await c.logout()
    expect(special).toMatchObject({
      '\\Inbox': 'INBOX',
      '\\Sent': 'Sent',
      '\\Drafts': 'Drafts',
      '\\Trash': 'Trash',
      '\\Junk': 'Junk',
      '\\Archive': 'Archive'
    })
  })

  it('nesprávne heslo je odmietnuté', async () => {
    const c = imap('alice', { auth: { user: 'alice@doar.test', pass: 'zle' } })
    await expect(c.connect()).rejects.toThrow()
  })

  it('certifikát sa overuje – bez dôveryhodnej CA sa spojenie odmietne', async () => {
    // Vlastný zoznam CA bez nášho testovacieho certifikátu = server nie je dôveryhodný.
    const c = imap('alice', { tls: { ca: [] as unknown as string } })
    await expect(c.connect()).rejects.toThrow(/certificate|self.signed/i)
  })

  it('STARTTLS na porte 3143 funguje', async () => {
    const c = imap('alice', { port: srv.ports.imap, secure: false, doSTARTTLS: true })
    await c.connect()
    expect(c.secureConnection).toBe(true)
    await c.logout()
  })

  it('porucha: server odmietne adresáta (550)', async () => {
    await expect(
      smtp('alice').sendMail({ from: srv.user('alice'), to: 'zlyhanie@doar.test', subject: 'x', text: 'x' })
    ).rejects.toMatchObject({ responseCode: 550 })
  })

  it('porucha: spojenie sa preruší po DATA – klient nedostane potvrdenie (nejasný výsledok)', async () => {
    const err = await smtp('alice')
      .sendMail({
        from: srv.user('alice'),
        to: [srv.user('carol'), 'prijate-prerusenie@doar.test'],
        subject: 'Možno doručené',
        text: 'x'
      })
      .then(() => null)
      .catch((e: unknown) => e as { code?: string; responseCode?: number })
    expect(err).not.toBeNull()
    expect(err?.responseCode).toBeUndefined() // žiadna odpoveď servera = nejasný výsledok

    // Správa však bola v skutočnosti doručená – presne situácia, kedy nesmieme automaticky odoslať znova.
    const c = imap('carol')
    await c.connect()
    const status = await c.status('INBOX', { messages: true })
    await c.logout()
    expect(status && status.messages).toBe(1)
  })

  it('porucha: plná schránka odmietne uloženie (kvóta)', async () => {
    const c = imap('plna')
    await c.connect()
    const big = Buffer.concat([Buffer.from('From: a@doar.test\r\nSubject: velka\r\n\r\n'), Buffer.alloc(40 * 1024, 'a')])
    await expect(c.append('INBOX', big)).rejects.toThrow()
    await c.logout()
  })
})
