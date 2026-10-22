import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from './helpers'

test('aplikácia sa spustí, rozhranie sa spojí s jadrom a vytvorí databázu', async () => {
  const { app, dataDir } = await launchApp()
  const win = await app.firstWindow()
  await expect(win.getByRole('heading', { name: /Vitajte v Doar Mail|Welcome to Doar Mail/ })).toBeVisible()
  // Stavový riadok ukáže verziu SQLite až po odpovedi jadra.
  await expect(win.getByRole('status')).toContainText('Doar Mail 0.3.0 · SQLite', { timeout: 15_000 })
  expect(existsSync(join(dataDir, 'doar.db'))).toBe(true)

  // Bezpečnosť: rozhranie nemá Node.js ani require.
  const hasNode = await win.evaluate(() => typeof (globalThis as Record<string, unknown>)['require'] !== 'undefined' || typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined')
  expect(hasNode).toBe(false)

  await win.screenshot({ path: 'test-results/start-sk.png' })

  // Prepnutie jazyka na angličtinu.
  await win.getByRole('combobox').selectOption('en')
  await expect(win.getByRole('heading', { name: 'Welcome to Doar Mail' })).toBeVisible()
  await win.screenshot({ path: 'test-results/start-en.png' })

  // Prepnutie jazyka z menu (Zobraziť → Jazyk / Language) – zmení rozhranie aj menu, bez reštartu.
  const clickLang = (label: string): Promise<void> =>
    app.evaluate(({ Menu }, l) => {
      for (const top of Menu.getApplicationMenu()?.items ?? []) {
        const lang = top.submenu?.items.find((i) => i.label === 'Jazyk / Language')
        lang?.submenu?.items.find((i) => i.label === l)?.click()
      }
    }, label)
  await clickLang('Slovenčina')
  await expect(win.getByRole('heading', { name: 'Vitajte v Doar Mail' })).toBeVisible()
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label).includes('Súbor'))).toBe(true)
  await clickLang('English')
  await expect(win.getByRole('heading', { name: 'Welcome to Doar Mail' })).toBeVisible()
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label).includes('File'))).toBe(true)

  // Názov a ikona okna.
  expect(await win.title()).toBe('Doar Mail')
  const icon = await app.evaluate(({ app: a, nativeImage }) => nativeImage.createFromPath(`${a.getAppPath()}/resources/icon.png`).getSize())
  expect(icon.width).toBe(512)
  await app.close()
})

test('rozhranie nesmie načítať nič z internetu', async () => {
  const { app } = await launchApp()
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const result = await win.evaluate(async () => {
    try {
      await fetch('https://example.com/pixel.gif')
      return 'loaded'
    } catch {
      return 'blocked'
    }
  })
  expect(result).toBe('blocked')
  await app.close()
})
