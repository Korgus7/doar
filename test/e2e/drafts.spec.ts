import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'olga'

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${user}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })

async function subjects(user: string, path: string): Promise<string[]> {
  const c = imap(user)
  await c.connect()
  try {
    const lock = await c.getMailboxLock(path)
    try {
      if (!c.mailbox || !c.mailbox.exists) return []
      const out: string[] = []
      for await (const m of c.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '')
      return out.sort()
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
}

test('koncepty: zatvorenie uloží koncept, otvorenie z Konceptov, odoslanie, zahodenie, jedno okno na koncept', async () => {
  test.setTimeout(180_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 760 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, USER)
  const folders = win.getByRole('navigation', { name: 'Priečinky' })
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })

  const newCompose = async (): Promise<Page> => {
    const [w] = await Promise.all([app.waitForEvent('window'), win.getByRole('button', { name: /Nová správa/ }).click()])
    await w.waitForLoadState('domcontentloaded')
    await expect(w.getByRole('button', { name: /Odoslať/ })).toBeEnabled()
    return w
  }
  const closeWindow = (title: string) =>
    app.evaluate(({ BrowserWindow }, t) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === t)?.close(), title)

  // 1. Písanie → priebežne uložené → zatvorenie bez otázky → koncept na serveri aj v Doare.
  const c1 = await newCompose()
  await c1.getByLabel('Komu').fill('pavol@doar.test')
  await c1.getByLabel('Predmet').fill('Ponuka na jeseň')
  await c1.getByLabel('Text správy').fill('Dobrý deň,\nposielam ponuku.')
  await expect(c1.getByRole('status')).toContainText('Koncept uložený', { timeout: 10_000 })
  await c1.screenshot({ path: 'test-results/koncept-ulozeny.png' })
  await Promise.all([c1.waitForEvent('close'), closeWindow('Ponuka na jeseň')])
  await expect.poll(() => subjects(USER, 'Drafts'), { timeout: 30_000 }).toEqual(['Ponuka na jeseň'])
  await folders.getByRole('button', { name: /^Koncepty/ }).click()
  const row = list.getByRole('option', { name: /Ponuka na jeseň/ })
  await expect(row).toBeVisible({ timeout: 20_000 })

  // 2. Ten istý koncept otvorený dvakrát → len jedno okno.
  const [c2] = await Promise.all([app.waitForEvent('window'), row.dblclick()])
  await c2.waitForLoadState('domcontentloaded')
  await expect(c2.getByRole('textbox', { name: 'Text správy' })).toContainText('posielam ponuku.')
  await expect(c2.getByLabel('Komu')).toHaveValue('pavol@doar.test')
  await row.click()
  await win.getByRole('region', { name: 'Čítanie správy' }).getByRole('button', { name: /Upraviť koncept/ }).click()
  await win.waitForTimeout(1500)
  expect(app.windows().filter((w) => !w.isClosed()).length).toBe(2) // hlavné + jedno okno konceptu

  // 3. Úprava a odoslanie → adresát dostane, z Konceptov zmizne.
  await c2.getByLabel('Text správy').fill('Dobrý deň,\nposielam upravenú ponuku.')
  await Promise.all([c2.waitForEvent('close'), c2.getByRole('button', { name: /Odoslať/ }).click()])
  await expect(list.getByRole('option', { name: /Ponuka na jeseň/ })).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(() => subjects(USER, 'Drafts'), { timeout: 30_000 }).toEqual([])
  await expect.poll(() => subjects('pavol', 'INBOX'), { timeout: 30_000 }).toContain('Ponuka na jeseň')

  // 4. Zahodiť → s potvrdením, koncept zmizne aj zo servera.
  const c3 = await newCompose()
  await c3.getByLabel('Predmet').fill('Zbytočná správa')
  await c3.getByLabel('Text správy').fill('Toto nechcem.')
  await expect(c3.getByRole('status')).toContainText('Koncept uložený', { timeout: 10_000 })
  c3.once('dialog', (d) => void d.accept())
  await Promise.all([c3.waitForEvent('close'), c3.getByRole('button', { name: /Zahodiť/ }).click()])
  await win.waitForTimeout(2000)
  expect(await subjects(USER, 'Drafts')).toEqual([])
  await expect(list.getByRole('option')).toHaveCount(0)

  // 5. Prázdne okno zatvorené bez písania → žiadny koncept.
  const c4 = await newCompose()
  await Promise.all([c4.waitForEvent('close'), closeWindow('Nová správa')])
  await win.waitForTimeout(1500)
  expect(await subjects(USER, 'Drafts')).toEqual([])

  await app.close()
})
