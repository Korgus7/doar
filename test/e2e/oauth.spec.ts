import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FakeGraph } from '../fixtures/graph-server'
import { launchApp } from './helpers'

const USER = 'dusan@outlook.com'
const graph = new FakeGraph()

/** Falošný prihlasovací server Microsoftu: overí PKCE a vydá token pre testovací server Graph. */
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
        ? { access_token: graph.token, refresh_token: 'rt-1', expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ email: USER })).toString('base64url')}.y` }
        : { error: 'invalid_grant' }
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(json))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), authorized: () => challenges.size }
}

test('Outlook.com cez Microsoft Graph: prihlásenie v sprievodcovi, pošta, odoslanie, nastavenia konta', async () => {
  test.setTimeout(120_000)
  const auth = await fakeAuth()
  await graph.start()
  await graph.addMessage('inbox', `From: Eva <eva@firma.sk>\r\nTo: ${USER}\r\nSubject: Vitaj v Outlooku\r\nMessage-ID: <v1@firma.sk>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nAhoj cez Graph\r\n`)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8', DOAR_OAUTH_TEST_URL: auth.base, DOAR_GRAPH_TEST_URL: graph.base })
  // Namiesto prehliadača používateľa: adresu prihlásenia „otvorí“ hlavný proces sám (presmerovania až späť do Doar).
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url)
    }
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()

  await win.getByRole('button', { name: 'Pridať konto' }).click()
  await win.getByLabel('Vaše meno').fill('Dušan Testový')
  await win.getByLabel('E‑mailová adresa').fill('dusan@hotmail.com')
  await win.getByRole('button', { name: 'Pokračovať' }).click()

  const signIn = win.getByRole('button', { name: 'Prihlásiť sa cez Microsoft' })
  await expect(signIn).toBeVisible({ timeout: 30_000 })
  await expect(win.getByText('Heslo zadáte priamo Microsoftu', { exact: false })).toBeVisible()
  await expect(win.getByRole('button', { name: 'Overiť a uložiť' })).toHaveCount(0)
  await expect(win.getByLabel('Heslo')).toHaveCount(0)
  await win.screenshot({ path: 'test-results/oauth-sprievodca.png' })

  await signIn.click()
  const sessionOnly = win.getByRole('button', { name: 'Pokračovať bez uloženia hesla' })
  const shell = win.getByRole('navigation', { name: 'Priečinky' })
  await expect(sessionOnly.or(shell)).toBeVisible({ timeout: 30_000 })
  if (await sessionOnly.isVisible()) await sessionOnly.click()
  // Konto dostane adresu, ktorou sa používateľ naozaj prihlásil.
  await expect(shell.getByText(USER)).toBeVisible({ timeout: 30_000 })
  expect(auth.authorized()).toBe(1)

  // Pošta cez Graph: priečinky Outlooku, správa aj s obsahom.
  await expect(shell.getByRole('button', { name: /^Odoslané/ })).toBeVisible({ timeout: 30_000 })
  await expect(shell.getByRole('button', { name: /^Kôš/ })).toBeVisible()
  await expect(shell.getByRole('button', { name: /^Outbox/ })).toHaveCount(0)
  await expect(win.getByText('Vitaj v Outlooku').first()).toBeVisible({ timeout: 30_000 })
  await win.getByText('Vitaj v Outlooku').first().click()
  await expect(win.frameLocator('iframe').first().getByText('Ahoj cez Graph').or(win.getByText('Ahoj cez Graph'))).toBeVisible({ timeout: 30_000 })

  // Odoslanie cez Graph.
  const [c] = await Promise.all([app.waitForEvent('window'), win.getByRole('button', { name: /Nová správa/ }).click()])
  // Okno je pripravené, keď má vybraté konto odosielateľa.
  await expect(c.getByRole('combobox', { name: /^Od/ })).toHaveValue(/\d+/, { timeout: 15_000 })
  await c.getByLabel('Komu').fill('eva@firma.sk')
  await c.getByLabel('Predmet').fill('Odpoveď z Doaru')
  await c.getByLabel('Text správy').fill('Ahoj Eva')
  await Promise.all([c.waitForEvent('close'), c.getByRole('button', { name: /^Odoslať ➤/ }).click()])
  await expect.poll(() => graph.sent.length, { timeout: 30_000 }).toBe(1)
  expect(graph.sent[0]!.toString()).toMatch(/^To: eva@firma\.sk$/m)
  await expect.poll(() => graph.inFolder('sentitems').length, { timeout: 10_000 }).toBe(1)

  // V nastaveniach konta: bez servera a hesla, len prihlásenie cez Microsoft.
  await win.getByRole('button', { name: 'Nastavenia' }).first().click()
  await win.getByText('Nastavenia servera', { exact: true }).click()
  await expect(win.getByText('Pošta tohto konta ide cez Microsoft Graph', { exact: false })).toBeVisible()
  await expect(win.getByLabel('Nové heslo')).toHaveCount(0)
  await expect(win.getByRole('button', { name: 'Overiť a uložiť' })).toHaveCount(0)
  await win.screenshot({ path: 'test-results/oauth-nastavenia.png' })
  await win.getByRole('button', { name: 'Prihlásiť sa znova cez Microsoft' }).click()
  await expect(win.getByText('Prihlásenie je obnovené.')).toBeVisible({ timeout: 30_000 })
  expect(auth.authorized()).toBe(2)

  await app.close()
  auth.close()
  await graph.close()
})
