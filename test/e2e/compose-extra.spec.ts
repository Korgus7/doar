import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'zuzana'

test.beforeAll(async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${USER}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })
  await c.connect()
  await c.append(
    'INBOX',
    Buffer.from(`From: =?UTF-8?Q?=C4=BDubom=C3=ADr_=C5=A0=C5=A5astn=C3=BD?= <lubo@stastny.sk>\r\nTo: ${USER}@doar.test\r\nSubject: Zmluva na tlac\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Text <b>zmluvy</b> na tla&#269;.</p><img src="https://sledovanie.sk/p.gif">\r\n`),
    []
  )
  await c.logout()
})

test('písanie: našepkávanie adries, odkaz, prepnutie na čistý text; tlač správy', async () => {
  test.setTimeout(150_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 760 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, USER)
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  await expect(list.getByRole('option')).toHaveCount(1, { timeout: 30_000 })

  // Tlač: náhrada systémového dialógu – zachytí sa vytlačený dokument.
  await app.evaluate(({ app: a }) => {
    a.on('browser-window-created', (_e, w) => {
      w.webContents.print = ((_opts: unknown, cb?: (ok: boolean, why: string) => void) => {
        const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
        const url = new URL(w.webContents.getURL())
        ;(globalThis as { printed?: string }).printed = fs.readFileSync(url, 'utf8')
        cb?.(true, '')
      }) as typeof w.webContents.print
    })
  })
  await list.getByRole('option', { name: /Zmluva na tlac/ }).click()
  const reader = win.getByRole('region', { name: 'Čítanie správy' })
  await expect(reader.getByRole('heading', { name: 'Zmluva na tlac' })).toBeVisible()
  await reader.getByRole('button', { name: 'Tlačiť' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { printed?: string }).printed ?? ''), { timeout: 10_000 }).toContain('zmluvy')
  const printed = await app.evaluate(() => (globalThis as { printed?: string }).printed!)
  expect(printed).toContain('Ľubomír Šťastný &lt;lubo@stastny.sk&gt;')
  expect(printed).toContain("default-src 'none'")
  expect(printed).not.toContain('sledovanie.sk') // vzdialený obrázok sa ani pri tlači nenačíta
  // Ctrl+P robí to isté.
  await app.evaluate(() => void ((globalThis as { printed?: string }).printed = ''))
  await win.keyboard.press('Control+p')
  await expect.poll(() => app.evaluate(() => (globalThis as { printed?: string }).printed ?? '')).toContain('zmluvy')

  // Nová správa: našepkávanie podľa odosielateľa doručenej pošty, bez diakritiky.
  const [c] = await Promise.all([app.waitForEvent('window'), win.getByRole('button', { name: /Nová správa/ }).click()])
  await c.waitForLoadState('domcontentloaded')
  await expect(c.getByRole('button', { name: /Odoslať/ })).toBeEnabled()
  const to = c.getByRole('combobox', { name: 'Komu' })
  await to.pressSequentially('stast')
  const opt = c.getByRole('option', { name: /Ľubomír Šťastný/ })
  await expect(opt).toBeVisible()
  await c.screenshot({ path: 'test-results/nasepkavanie.png' })
  await to.press('Enter')
  await expect(to).toHaveValue('Ľubomír Šťastný <lubo@stastny.sk>, ')

  // Odkaz cez Ctrl+K.
  const editor = c.getByRole('textbox', { name: 'Text správy' })
  await editor.click()
  await c.keyboard.type('Pozri ')
  await c.keyboard.press('Control+k')
  const url = c.getByLabel('Adresa odkazu')
  await url.fill('firma.sk/cennik')
  await url.press('Enter')
  expect(await editor.innerHTML()).toContain('<a href="https://firma.sk/cennik">https://firma.sk/cennik</a>')
  await c.screenshot({ path: 'test-results/formatovanie.png' })

  // Prepnutie na čistý text (formátovanie sa stratí – s potvrdením).
  c.once('dialog', (d) => void d.accept())
  await c.getByRole('button', { name: /Formátovanie/ }).click()
  await expect(c.getByRole('textbox', { name: 'Text správy' })).toHaveValue('Pozri https://firma.sk/cennik')
  await expect(c.getByRole('button', { name: /Čistý text/ })).toBeVisible()

  await app.close()
})
