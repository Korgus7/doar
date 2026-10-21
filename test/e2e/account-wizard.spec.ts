import { test, expect, type Page } from '@playwright/test'
import { launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

async function fillIdentity(win: Page, password: string): Promise<void> {
  await win.getByRole('button', { name: 'Pridať konto' }).click()
  await win.getByLabel('Vaše meno').fill('Alica Testová')
  await win.getByLabel('E‑mailová adresa').fill('alice@doar.test')
  await win.getByLabel('Heslo').fill(password)
  await win.getByRole('button', { name: 'Pokračovať' }).click()
}

async function fillServers(win: Page): Promise<void> {
  // doar.test neexistuje v DNS → automatické zistenie nič nenájde a ponúkne ručné nastavenie.
  await expect(win.getByText('Nastavenia sa nepodarilo zistiť automaticky', { exact: false })).toBeVisible({ timeout: 40_000 })
  const servers = win.getByLabel('Server')
  const ports = win.getByLabel('Port')
  await servers.nth(0).fill('127.0.0.1')
  await ports.nth(0).fill(String(srv!.ports.imaps))
  await servers.nth(1).fill('127.0.0.1')
  await ports.nth(1).fill(String(srv!.ports.smtps))
}

test('sprievodca: nesprávne heslo → zrozumiteľná chyba, oprava → konto sa pridá', async () => {
  test.setTimeout(120_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()

  await fillIdentity(win, 'zle-heslo')
  await fillServers(win)
  await win.getByRole('button', { name: 'Overiť a uložiť' }).click()
  await expect(win.getByText('Nesprávne používateľské meno alebo heslo.').first()).toBeVisible({ timeout: 30_000 })
  await win.screenshot({ path: 'test-results/wizard-zle-heslo.png' })

  // Oprava hesla priamo vo formulári.
  await win.getByLabel('Heslo').fill(srv!.password)
  await win.getByRole('button', { name: 'Overiť a uložiť' }).click()

  // Na Linuxe v testoch nie je kľúčenka systému → Doar to povie a ponúkne heslo len do zatvorenia.
  // Na Windowse (DPAPI) sa konto uloží rovno.
  const sessionOnly = win.getByRole('button', { name: 'Pokračovať bez uloženia hesla' })
  const shell = win.getByRole('navigation', { name: 'Priečinky' })
  await expect(sessionOnly.or(shell)).toBeVisible({ timeout: 30_000 })
  if (await sessionOnly.isVisible()) {
    await expect(win.getByText('Systém nemá bezpečné úložisko hesiel', { exact: false })).toBeVisible()
    await win.screenshot({ path: 'test-results/wizard-bez-kluccenky.png' })
    await sessionOnly.click()
  }
  await expect(shell).toBeVisible()
  await expect(shell.getByText('alice@doar.test')).toBeVisible()
  await win.screenshot({ path: 'test-results/wizard-hotovo.png' })
  await app.close()
})

test('menu je po slovensky a „Pridať konto…“ z menu otvorí sprievodcu', async () => {
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? [])
  expect(labels).toEqual(expect.arrayContaining(['Súbor', 'Úpravy', 'Zobraziť', 'Pomocník']))
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Súbor')
    file?.submenu?.items.find((i) => i.label === 'Pridať konto…')?.click()
  })
  await expect(win.getByRole('heading', { name: 'Pridať konto' })).toBeVisible()

  // Prepnutie jazyka prestaví aj menu.
  await win.getByRole('button', { name: 'Zrušiť' }).click()
  await win.getByRole('combobox').selectOption('en')
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? [])).toEqual(expect.arrayContaining(['File', 'Edit', 'View', 'Help']))
  await app.close()
})
