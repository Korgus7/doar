import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'tomas'

test.beforeAll(async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${USER}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })
  await c.connect()
  await c.append('INBOX', Buffer.from(`From: jan@firma.sk\r\nTo: ${USER}@doar.test\r\nSubject: Ostane na serveri\r\n\r\nText\r\n`), [])
  await c.logout()
})

test('nastavenia: názov, farba, podpis v novej správe, server, upozornenia, odstránenie konta', async () => {
  test.setTimeout(150_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, USER)
  const folders = win.getByRole('navigation', { name: 'Priečinky' })
  await expect(win.getByRole('listbox', { name: 'Zoznam správ' }).getByRole('option')).toHaveCount(1, { timeout: 30_000 })

  // Názov, farba, podpis.
  await win.getByRole('button', { name: 'Nastavenia', exact: true }).click()
  const dlg = win.getByRole('dialog', { name: 'Nastavenia' })
  await dlg.getByLabel('Názov konta').fill('Práca')
  await dlg.getByLabel('Meno odosielateľa').fill('Tomáš Kováč')
  await dlg.getByRole('radio', { name: 'Farba 3' }).check()
  await dlg.getByLabel('Podpis').fill('S pozdravom\nTomáš Kováč')
  await dlg.getByRole('button', { name: 'Uložiť', exact: true }).click()
  await expect(dlg.getByText('Uložené.')).toBeVisible()
  await expect(folders.getByText('Práca')).toBeVisible()
  await win.screenshot({ path: 'test-results/nastavenia-konto.png' })

  // Server: zlé heslo sa neuloží, s uloženým heslom áno.
  await dlg.getByText('Nastavenia servera').click()
  await dlg.getByLabel('Nové heslo').fill('zle-heslo')
  await dlg.getByRole('button', { name: 'Overiť a uložiť' }).click()
  await expect(dlg.getByText('Nastavenia sa neuložili')).toBeVisible({ timeout: 30_000 })
  await expect(dlg.getByText('Nesprávne používateľské meno alebo heslo.').first()).toBeVisible()
  await dlg.getByLabel('Nové heslo').fill('')
  await dlg.getByRole('button', { name: 'Overiť a uložiť' }).click()
  await expect(dlg.getByText('Nastavenia servera sú overené a uložené.')).toBeVisible({ timeout: 30_000 })

  // Všeobecné: upozornenia.
  await dlg.getByRole('tab', { name: 'Všeobecné' }).click()
  const showContent = dlg.getByLabel('V upozornení zobraziť odosielateľa a predmet')
  await expect(showContent).toBeChecked()
  await showContent.uncheck()
  await win.screenshot({ path: 'test-results/nastavenia-vseobecne.png' })
  await win.keyboard.press('Escape')
  await win.getByRole('button', { name: 'Nastavenia', exact: true }).click()
  await dlg.getByRole('tab', { name: 'Všeobecné' }).click()
  await expect(dlg.getByLabel('V upozornení zobraziť odosielateľa a predmet')).not.toBeChecked()
  await win.keyboard.press('Escape')

  // Podpis v novej správe.
  const [c] = await Promise.all([app.waitForEvent('window'), win.getByRole('button', { name: /Nová správa/ }).click()])
  await c.waitForLoadState('domcontentloaded')
  // Prázdny prvý odsek (kurzor), potom podpis „--“ a jeho riadky.
  expect(await c.getByRole('textbox', { name: 'Text správy' }).innerHTML()).toMatch(/^<p><br class="ProseMirror-trailingBreak"><\/p><p>--<br>S pozdravom<br>Tomáš Kováč<\/p>$/)
  await Promise.all([c.waitForEvent('close'), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Nová správa')?.close())])

  // Odstránenie konta → uvítanie; pošta na serveri zostane.
  await win.getByRole('button', { name: 'Nastavenia', exact: true }).click()
  win.once('dialog', (d) => void d.accept())
  await dlg.getByRole('button', { name: 'Odstrániť konto…' }).click()
  await expect(win.getByRole('heading', { name: 'Vitajte v Doar Mail' })).toBeVisible({ timeout: 15_000 })
  const imap = new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${USER}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })
  await imap.connect()
  const st = await imap.status('INBOX', { messages: true })
  await imap.logout()
  expect((st as { messages: number }).messages).toBe(1)

  await app.close()
})
