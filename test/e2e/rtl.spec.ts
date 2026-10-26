/// <reference lib="dom" />
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'lenka'
const b64 = (s: string): string => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`

test.beforeAll(async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${USER}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })
  await c.connect()
  await c.append(
    'INBOX',
    Buffer.from(
      `From: ${b64('דנה כהן')} <dana@example.co.il>\r\nTo: ${USER}@doar.test\r\nSubject: ${b64('פגישה ביום ראשון')}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nשלום, נפגש ביום ראשון בשעה 10:00 במשרד?\r\n\r\nThanks, Dana\r\n`
    ),
    []
  )
  await c.logout()
})

test('hebrejčina: rozhranie sprava doľava, hebrejská správa, písanie odpovede; späť na slovenčinu', async () => {
  test.setTimeout(120_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 760 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, USER)

  const clickLang = (label: string): Promise<void> =>
    app.evaluate(({ Menu }, l) => {
      for (const top of Menu.getApplicationMenu()?.items ?? []) {
        const lang = top.submenu?.items.find((i) => i.label === 'Jazyk / Language')
        lang?.submenu?.items.find((i) => i.label === l)?.click()
      }
    }, label)
  // V ponuke sú všetky jazyky.
  const names = await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const lang = top.submenu?.items.find((i) => i.label === 'Jazyk / Language')
      if (lang) return lang.submenu!.items.map((i) => i.label)
    }
    return []
  })
  expect(names).toEqual(['Slovenčina', 'English', 'Čeština', 'Deutsch', 'Magyar', 'Français', 'Español', 'Русский', 'עברית'])

  await clickLang('עברית')
  await expect(win.getByRole('button', { name: /הודעה חדשה/ })).toBeVisible()
  expect(await win.evaluate(() => [document.documentElement.lang, document.documentElement.dir])).toEqual(['he', 'rtl'])
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label).includes('קובץ'))).toBe(true)

  // Zrkadlové rozloženie: priečinky vpravo od zoznamu správ.
  const folders = await win.getByRole('navigation', { name: 'תיקיות' }).boundingBox()
  const list = win.getByRole('listbox', { name: 'רשימת הודעות' })
  const listBox = await list.boundingBox()
  expect(folders!.x).toBeGreaterThan(listBox!.x)

  // Hebrejská správa: predmet v zozname, text v čítačke zarovnaný sprava, anglický riadok zľava.
  await list.getByRole('option', { name: /פגישה ביום ראשון/ }).click()
  const reader = win.getByRole('region', { name: 'הודעה' })
  await expect(reader.getByRole('heading', { name: 'פגישה ביום ראשון' })).toBeVisible()
  const frame = reader.frameLocator('iframe')
  await expect(frame.locator('body')).toContainText('נפגש ביום ראשון')
  const lines = await frame.locator('body').evaluate((body) => {
    const doc = body.ownerDocument
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    const out: { text: string; left: number; right: number }[] = []
    const width = body.clientWidth
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const r = doc.createRange()
      r.selectNodeContents(n)
      for (const rect of Array.from(r.getClientRects())) out.push({ text: (n.textContent ?? '').slice(0, 10), left: rect.left, right: width - rect.right })
    }
    return out
  })
  const hebrew = lines.find((l) => /[֐-׿]/.test(l.text))!
  const latin = lines.find((l) => l.text.startsWith('Thanks'))
  expect(hebrew.right).toBeLessThan(hebrew.left) // bližšie k pravému okraju
  if (latin) expect(latin.left).toBeLessThan(latin.right) // anglický riadok zostáva vľavo
  await win.screenshot({ path: 'test-results/rtl-hlavne-okno.png' })

  // Odpoveď po hebrejsky: odsek dostane smer sprava doľava a dir="auto" ide aj do odosielaného HTML.
  const [c] = await Promise.all([app.waitForEvent('window'), reader.getByRole('button', { name: /^השב$/ }).click()])
  await c.waitForLoadState('domcontentloaded')
  await expect(c.getByRole('button', { name: /שליחה/ })).toBeEnabled()
  expect(await c.evaluate(() => document.documentElement.dir)).toBe('rtl')
  const editor = c.getByRole('textbox', { name: 'תוכן ההודעה' })
  await editor.click()
  await editor.press('Control+Home')
  await c.keyboard.type('תודה, מתאים לי.')
  const p = editor.locator('p').first()
  await expect(p).toHaveText('תודה, מתאים לי.')
  expect(await p.getAttribute('dir')).toBe('auto')
  expect(await p.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl')
  await c.screenshot({ path: 'test-results/rtl-odpoved.png' })
  await c.close()

  // Späť na slovenčinu: zľava doprava.
  await clickLang('Slovenčina')
  await expect(win.getByRole('button', { name: /Nová správa/ })).toBeVisible()
  expect(await win.evaluate(() => document.documentElement.dir)).toBe('ltr')
  const folders2 = await win.getByRole('navigation', { name: 'Priečinky' }).boundingBox()
  expect(folders2!.x).toBeLessThan((await win.getByRole('listbox', { name: 'Zoznam správ' }).boundingBox())!.x)
  await app.close()
})
