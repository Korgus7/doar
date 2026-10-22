import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

test('aktualizácie: ručná kontrola, ponuka novej verzie, „Čo je nové“, pri vývoji sa neinštaluje; nastavenia', async () => {
  test.setTimeout(90_000)
  // Testovací zdroj aktualizácií: priečinok s manifestom (ako dist po npm run dist).
  const feed = mkdtempSync(join(tmpdir(), 'doar-e2e-feed-'))
  writeFileSync(join(feed, 'doar-mail-update.json'), JSON.stringify({ app: 'doar-mail', version: '9.9.9', file: 'Doar-Mail-9.9.9-win-x64.zip', size: 1234, sha256: 'a'.repeat(64) }))
  writeFileSync(join(feed, 'notes.txt'), 'Novinky v 9.9.9:\n- aktualizácie')
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8', DOAR_UPDATE_FEED: feed })
  const win = await app.firstWindow()
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, 'beata')

  await app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Pomocník')
    help?.submenu?.items.find((i) => i.label === 'Skontrolovať aktualizácie…')?.click()
  })
  const banner = win.getByRole('status').filter({ hasText: 'Je k dispozícii Doar Mail 9.9.9' })
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Čo je nové' }).click()
  await expect(banner.getByText('- aktualizácie')).toBeVisible()
  // Pri vývoji (nezabalená aplikácia) sa nič neinštaluje.
  await expect(banner.getByRole('button', { name: /Stiahnuť/ })).toBeDisabled()
  await win.screenshot({ path: 'test-results/aktualizacia.png' })
  await banner.getByRole('button', { name: 'Neskôr' }).click()
  await expect(banner).toHaveCount(0)

  // Nastavenia → Všeobecné: verzia, automatická kontrola, ručná kontrola.
  await win.getByRole('button', { name: 'Nastavenia' }).first().click()
  const dlg = win.getByRole('dialog')
  await dlg.getByRole('tab', { name: /Všeobecné/ }).click()
  await expect(dlg.getByText('Verzia 0.3.0', { exact: false })).toBeVisible()
  const auto = dlg.getByRole('checkbox', { name: /Automaticky kontrolovať nové verzie/ })
  await expect(auto).toBeChecked()
  await auto.uncheck()
  await expect.poll(() => win.evaluate(() => (globalThis as unknown as { doar: { updateState(): Promise<{ auto: boolean }> } }).doar.updateState().then((s) => s.auto))).toBe(false)
  await auto.check()
  await dlg.getByRole('button', { name: 'Skontrolovať teraz' }).click()
  await win.keyboard.press('Escape')
  await expect(win.getByRole('status').filter({ hasText: 'Je k dispozícii Doar Mail 9.9.9' })).toBeVisible()
  await app.close()
})

test('aktualizácie cez GitHub API: kontrola nie je zablokovaná ochranou okien pred internetom', async () => {
  test.setTimeout(90_000)
  // Náhrada GitHub API na lokálnom serveri: vydanie s manifestom a zipom.
  const manifest = { app: 'doar-mail', version: '9.9.8', file: 'Doar-Mail-9.9.8-win-x64.zip', size: 4321, sha256: 'b'.repeat(64) }
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    if (req.url === '/repos/Korgus7/doar/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag_name: 'v9.9.8', body: 'Novinky z GitHubu', html_url: 'https://github.com/Korgus7/doar/releases/tag/v9.9.8', assets: [
        { name: 'doar-mail-update.json', browser_download_url: `${base}/m.json`, size: 100 },
        { name: manifest.file, browser_download_url: `${base}/z.zip`, size: manifest.size }
      ] }))
    } else if (req.url === '/m.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(manifest))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const { app } = await launchApp({ LANG: 'sk_SK.UTF-8', DOAR_UPDATE_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
    const win = await app.firstWindow()
    await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
    await addAccountViaWizard(win, srv!, 'cyril')
    await app.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Pomocník')
      help?.submenu?.items.find((i) => i.label === 'Skontrolovať aktualizácie…')?.click()
    })
    const banner = win.getByRole('status').filter({ hasText: 'Je k dispozícii Doar Mail 9.9.8' })
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await banner.getByRole('button', { name: 'Čo je nové' }).click()
    await expect(banner.getByText('Novinky z GitHubu')).toBeVisible()
    await app.close()
  } finally {
    server.close()
  }
})
