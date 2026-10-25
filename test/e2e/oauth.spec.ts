import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { testAccessToken } from '../../scripts/testserver.mjs'
import { launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'dusan@doar.test'

/** Falošný prihlasovací server Microsoftu: overí PKCE a vydá token pre testovací poštový server. */
async function fakeAuth(): Promise<{ base: string; close: () => void; authorized: () => number }> {
  const challenges = new Map<string, string>()
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    if (u.pathname === '/authorize') {
      const code = `code-${challenges.size + 1}`
      challenges.set(code, u.searchParams.get('code_challenge')!)
      const back = new URL(u.searchParams.get('redirect_uri')!)
      back.searchParams.set('state', u.searchParams.get('state')!)
      back.searchParams.set('code', code)
      res.writeHead(302, { location: back.toString() }).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const p = new URLSearchParams(body)
      const challenge = challenges.get(p.get('code') ?? '')
      const ok = challenge && createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') === challenge
      const json = ok
        ? { access_token: testAccessToken(USER), refresh_token: 'rt-1', expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ email: USER })).toString('base64url')}.y` }
        : { error: 'invalid_grant' }
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(json))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), authorized: () => challenges.size }
}

test('Outlook.com: prihlásenie cez Microsoft v sprievodcovi, bez hesla → konto sa pridá', async () => {
  test.setTimeout(120_000)
  const auth = await fakeAuth()
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8', DOAR_OAUTH_TEST_URL: auth.base })
  // Namiesto prehliadača používateľa: adresu prihlásenia „otvorí“ hlavný proces sám (presmerovania až späť do Doar).
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url)
    }
  })
  const win = await app.firstWindow()
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()

  await win.getByRole('button', { name: 'Pridať konto' }).click()
  await win.getByLabel('Vaše meno').fill('Dušan Testový')
  await win.getByLabel('E‑mailová adresa').fill('dusan@outlook.com')
  await win.getByRole('button', { name: 'Pokračovať' }).click()

  const signIn = win.getByRole('button', { name: 'Prihlásiť sa cez Microsoft' })
  await expect(signIn).toBeVisible({ timeout: 30_000 })
  await expect(win.getByText('Heslo zadáte priamo Microsoftu', { exact: false })).toBeVisible()
  await expect(win.getByRole('button', { name: 'Overiť a uložiť' })).toHaveCount(0)
  await expect(win.getByLabel('Heslo')).toHaveCount(0)
  await win.screenshot({ path: 'test-results/oauth-sprievodca.png' })

  // Skutočné servery Outlooku sú v teste nedostupné → nasmerujeme ich na testovací server.
  await win.getByRole('button', { name: 'Upraviť ručne' }).click()
  await expect(win.getByLabel('Heslo')).toHaveCount(0)
  const servers = win.getByLabel('Server')
  const ports = win.getByLabel('Port')
  await servers.nth(0).fill('127.0.0.1')
  await ports.nth(0).fill(String(srv!.ports.imaps))
  await servers.nth(1).fill('127.0.0.1')
  await win.getByLabel('Zabezpečenie').nth(1).selectOption('tls')
  await ports.nth(1).fill(String(srv!.ports.smtps))

  await signIn.click()
  const sessionOnly = win.getByRole('button', { name: 'Pokračovať bez uloženia hesla' })
  const shell = win.getByRole('navigation', { name: 'Priečinky' })
  await expect(sessionOnly.or(shell)).toBeVisible({ timeout: 30_000 })
  if (await sessionOnly.isVisible()) await sessionOnly.click()
  // Konto dostane adresu, ktorou sa používateľ naozaj prihlásil.
  await expect(shell.getByText(USER)).toBeVisible({ timeout: 30_000 })
  expect(auth.authorized()).toBe(1)

  // V nastaveniach konta: namiesto hesla prihlásenie cez Microsoft.
  await win.getByRole('button', { name: 'Nastavenia' }).first().click()
  await win.getByText('Nastavenia servera', { exact: true }).click()
  await expect(win.getByText('Prihlásenie cez Microsoft – heslo sa neukladá.')).toBeVisible()
  await expect(win.getByRole('button', { name: 'Prihlásiť sa znova cez Microsoft' })).toBeVisible()
  await expect(win.getByLabel('Nové heslo')).toHaveCount(0)
  await win.screenshot({ path: 'test-results/oauth-nastavenia.png' })
  await win.getByRole('button', { name: 'Prihlásiť sa znova cez Microsoft' }).click()
  await expect(win.getByText('Prihlásenie je obnovené.')).toBeVisible({ timeout: 30_000 })
  expect(auth.authorized()).toBe(2)

  await app.close()
  auth.close()
})
