import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, openSettingsTab, testServer } from './helpers'

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
  await dlg.getByRole('button', { name: 'Uložiť', exact: true }).click()
  await expect(dlg.getByText('Uložené.')).toBeVisible()
  // Podpis (od 0.9 formátovaný, môže ich byť viac).
  await dlg.getByRole('button', { name: 'Nový podpis' }).click()
  const sigEditor = dlg.getByRole('textbox', { name: 'Text podpisu' })
  await sigEditor.click()
  await win.keyboard.type('S pozdravom')
  await win.keyboard.press('Shift+Enter')
  await win.keyboard.type('Tomáš Kováč')
  await dlg.getByRole('button', { name: 'Uložiť podpis' }).click()
  await expect(dlg.getByText('Podpis je uložený.')).toBeVisible()
  await expect(dlg.getByRole('radio', { name: 'Podpis 1' })).toBeChecked()
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
  expect(await c.getByRole('textbox', { name: 'Text správy' }).innerHTML()).toMatch(/^<p dir="auto"><br class="ProseMirror-trailingBreak"><\/p><p dir="auto">--<\/p><p dir="auto">S pozdravom<br>Tomáš Kováč<\/p>$/)
  await Promise.all([c.waitForEvent('close'), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Nová správa')?.close())])

  // Vzhľad: Tmavý / Svetlý / Podľa systému – prepne sa hneď a zapamätá sa.
  await win.getByRole('button', { name: 'Nastavenia', exact: true }).click()
  await dlg.getByRole('tab', { name: 'Všeobecné' }).click()
  await dlg.getByLabel('Vzhľad').selectOption('dark')
  expect(await win.evaluate(() => [document.documentElement.dataset['theme'], getComputedStyle(document.body).colorScheme])).toEqual(['dark', 'dark'])
  expect(await win.evaluate(() => localStorage.getItem('doar.theme'))).toBe('dark')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  await dlg.getByLabel('Vzhľad').selectOption('light')
  expect(await win.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe('light')
  await dlg.getByLabel('Vzhľad').selectOption('system')
  expect(await win.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false)
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  await win.keyboard.press('Escape')

  // Konto sa dá zbaliť a rozbaliť (zapamätá sa).
  const accToggle = folders.getByRole('button', { name: /Práca/ })
  await expect(accToggle).toHaveAttribute('aria-expanded', 'true')
  await accToggle.click()
  await expect(accToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(folders.getByRole('button', { name: /^Doručená pošta/ })).toBeHidden()
  await accToggle.click()
  await expect(folders.getByRole('button', { name: /^Doručená pošta/ })).toBeVisible()

  // Bez ponuky ☰: všetko je v Nastaveniach. Kontá → „+ Pridať konto…“ otvorí sprievodcu.
  await expect(win.getByRole('button', { name: 'Ponuka' })).toHaveCount(0)
  let set = await openSettingsTab(win, 'Kontá')
  await expect(set.getByRole('tab')).toHaveText(['Kontá', 'Všeobecné', 'Pravidlá', 'AI', 'Záloha', 'O aplikácii'])
  await set.getByRole('button', { name: '+ Pridať konto…' }).click()
  await expect(win.getByRole('heading', { name: 'Pridať konto' })).toBeVisible()
  await win.getByRole('button', { name: 'Zrušiť' }).click()
  await expect(folders).toBeVisible()

  // Záloha: štyri voľby, každá s vysvetlením; „Obnoviť zálohu do konta…“ otvorí obnovu.
  set = await openSettingsTab(win, 'Záloha')
  await expect(set.getByRole('tabpanel').getByRole('button')).toHaveText([
    'Zálohovať konto…',
    'Obnoviť zálohu do konta…',
    'Prezrieť zálohu alebo uloženú správu…',
    'Preniesť poštu z iného programu…'
  ])
  await expect(set.getByText('len na čítanie', { exact: false })).toBeVisible()
  await set.getByRole('button', { name: 'Obnoviť zálohu do konta…' }).click()
  await expect(set).toBeHidden()
  const rest = win.getByRole('dialog', { name: 'Obnoviť zo zálohy' })
  await expect(rest).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(rest).toBeHidden()

  // O aplikácii: stránka, GitHub, e-mail a Podporiť Doar (odkazy idú do prehliadača).
  await app.evaluate(({ shell }) => {
    const g = globalThis as { opened?: string; origOpen?: unknown }
    g.origOpen = shell.openExternal
    shell.openExternal = async (url: string) => {
      g.opened = url
    }
  })
  set = await openSettingsTab(win, 'O aplikácii')
  await expect(set.getByRole('heading', { name: /^Doar/ })).toBeVisible()
  await set.getByRole('button', { name: 'GitHub' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string }).opened)).toBe('https://github.com/Korgus7/doar')
  await set.getByRole('button', { name: 'Webová stránka' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string }).opened)).toBe('https://doar.sk/')
  await set.getByRole('button', { name: 'info@doar.sk' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string }).opened)).toBe('mailto:info@doar.sk')
  // Podporiť Doar: okno s QR kódom a PayPal (odkaz do prehliadača).
  const [sup] = await Promise.all([app.waitForEvent('window'), set.getByRole('button', { name: 'Podporiť Doar' }).click()])
  await expect(sup.getByRole('heading', { name: 'Podporiť Doar' })).toBeVisible()
  await expect(sup.getByRole('img', { name: /QR kódom/ })).toBeVisible()
  await sup.getByRole('link', { name: 'Prispieť cez PayPal' }).click({ noWaitAfter: true })
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string }).opened)).toBe('https://paypal.me/korgus')
  await sup.close()
  await set.getByRole('button', { name: 'Zavrieť' }).click()
  await app.evaluate(({ shell }) => {
    const g = globalThis as { origOpen?: typeof shell.openExternal }
    shell.openExternal = g.origOpen!
  })

  // Ponechať len v počítači: konto ostane, v zozname priečinkov má značku, nastavenia servera zmiznú.
  await win.getByRole('button', { name: 'Nastavenia', exact: true }).click()
  win.once('dialog', (d) => void d.accept())
  await dlg.getByRole('button', { name: 'Ponechať len v počítači…' }).click()
  await expect(dlg.getByText(/Toto konto je len v počítači/)).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Ponechať len v počítači…' })).toHaveCount(0)
  await expect(dlg.getByText('Nastavenia servera', { exact: true })).toHaveCount(0)
  await set.getByRole('button', { name: 'Zavrieť' }).click()
  await expect(win.locator('.local-tag')).toHaveText('v počítači')

  // Odstránenie konta → uvítanie; pošta na serveri zostane.
  await win.getByRole('button', { name: 'Nastavenia', exact: true }).click()
  win.once('dialog', (d) => void d.accept())
  await dlg.getByRole('button', { name: 'Odstrániť konto…' }).click()
  await expect(win.getByRole('heading', { name: 'Vitajte v programe Doar' })).toBeVisible({ timeout: 15_000 })
  const imap = new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${USER}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })
  await imap.connect()
  const st = await imap.status('INBOX', { messages: true })
  await imap.logout()
  expect((st as { messages: number }).messages).toBe(1)

  await app.close()
})
