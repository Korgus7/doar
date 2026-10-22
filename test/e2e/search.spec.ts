import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'sona'
const msg = (subject: string, body: string, from = 'Ján Novák <jan@firma.sk>') =>
  Buffer.from(
    `From: ${from}\r\nTo: ${USER}@doar.test\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`
  )

test.beforeAll(async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${USER}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })
  await c.connect()
  await c.mailboxCreate('Zmluvy')
  await c.append('INBOX', msg('Žiadosť o cenovú ponuku', 'Prosíme o ponuku na 20 stoličiek.'), [])
  await c.append('INBOX', msg('Obed', 'Ideme v piatok?', 'Eva <eva@mail.sk>'), [])
  await c.append('Zmluvy', msg('Zmluva o dielo', 'V prílohe posielam zmluvu a cenovú ponuku.'), [])
  await c.logout()
})

test('vyhľadávanie: bez diakritiky, v texte, rozsah priečinka, zrušenie', async () => {
  test.setTimeout(120_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 760 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, USER)
  const folders = win.getByRole('navigation', { name: 'Priečinky' })
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  await expect(list.getByRole('option')).toHaveCount(2, { timeout: 30_000 })
  // Počkať na stiahnutie textov (hľadanie v texte).
  await expect(win.getByRole('status').filter({ hasText: /Synchronizované/ })).toBeVisible({ timeout: 30_000 })
  await expect(win.getByRole('status').filter({ hasText: /sťahujem obsah/ })).toHaveCount(0, { timeout: 30_000 })

  // Ctrl+E → pole hľadania; „cenovu ponuk“ bez diakritiky nájde predmet aj text v inom priečinku.
  await list.focus()
  await win.keyboard.press('Control+e')
  const box = win.getByRole('searchbox', { name: 'Hľadať v pošte' })
  await expect(box).toBeFocused()
  await win.keyboard.type('cenovu ponuk')
  await expect(win.getByText('Nájdené: 2')).toBeVisible()
  await expect(list.getByRole('option', { name: /Žiadosť o cenovú ponuku/ })).toBeVisible()
  await expect(list.getByRole('option', { name: /Zmluva o dielo.*Zmluvy/ })).toBeVisible() // ukáže aj priečinok
  await win.screenshot({ path: 'test-results/hladanie.png' })

  // Otvorenie výsledku.
  await list.getByRole('option', { name: /Zmluva o dielo/ }).click()
  await expect(win.frameLocator('iframe').getByText('posielam zmluvu')).toBeVisible()

  // Len v priečinku: najprv priečinok (zruší hľadanie), potom hľadať a zvoliť rozsah.
  await folders.getByRole('button', { name: /^Doručená pošta/ }).click()
  await expect(box).toHaveValue('')
  await box.fill('ponuk')
  await box.press('Enter')
  await expect(win.getByText('Nájdené: 2')).toBeVisible()
  await win.getByRole('combobox', { name: 'Kde hľadať' }).selectOption({ label: 'V priečinku Doručená pošta' })
  await expect(win.getByText('Nájdené: 1')).toBeVisible()

  // Nič sa nenašlo; Esc zruší hľadanie a vráti priečinok.
  await box.fill('xyzneexistuje')
  await box.press('Enter')
  await expect(list.getByText('Nič sa nenašlo.')).toBeVisible()
  await box.press('Escape')
  await expect(list.getByRole('option')).toHaveCount(2)

  await app.close()
})
