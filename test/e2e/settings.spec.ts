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

  // Ponuka ☰: položky, ktoré boli dole v paneli; „Pridať konto…“ otvorí sprievodcu.
  await win.getByRole('button', { name: 'Ponuka' }).click()
  const menu = win.getByRole('menu', { name: 'Ponuka' })
  await expect(menu.getByRole('menuitem')).toHaveText([/^Pridať konto…/, /^Zálohovať konto…/, /^Obnoviť zo zálohy…/, /^Importovať z iného programu…/, /^Otvoriť archív…/, /^Otvoriť správu zo súboru \(\.eml\)…/, /Zoskupiť do konverzácií/, /^Nastavenia…/, /^Skontrolovať aktualizácie…/, /^O aplikácii Doar/])
  await menu.getByRole('menuitem', { name: 'Pridať konto…' }).click()
  await expect(win.getByRole('heading', { name: 'Pridať konto' })).toBeVisible()
  await win.getByRole('button', { name: 'Zrušiť' }).click()
  await expect(folders).toBeVisible()

  // O aplikácii: odkaz na stránku a na GitHub (tlačidlo „GitHub“ otvorí repozitár v prehliadači).
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as { about?: string; opened?: string; origBox?: unknown; origOpen?: unknown }
    g.origBox = dialog.showMessageBox
    g.origOpen = shell.openExternal
    dialog.showMessageBox = (async (...a: unknown[]) => {
      const o = a[a.length - 1] as { detail?: string; buttons?: string[] }
      g.about = `${o.detail}|${(o.buttons ?? []).join(',')}`
      return { response: 2, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
    shell.openExternal = async (url: string) => {
      g.opened = url
    }
  })
  await win.getByRole('button', { name: 'Ponuka' }).click()
  await win.getByRole('menu', { name: 'Ponuka' }).getByRole('menuitem', { name: /^O aplikácii Doar/ }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string }).opened)).toBe('https://github.com/Korgus7/doar')
  const about = await app.evaluate(() => (globalThis as { about?: string }).about)
  expect(about).toContain('https://doar.sk')
  expect(about).toContain('info@doar.sk')
  expect(about).toContain('OK,Webová stránka,GitHub,Podporiť Doar')
  // Podporiť Doar: okno s QR kódom a PayPal (odkaz do prehliadača).
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 3, checkboxChecked: false })) as typeof dialog.showMessageBox
  })
  const [sup] = await Promise.all([app.waitForEvent('window'), (async () => {
    await win.getByRole('button', { name: 'Ponuka' }).click()
    await win.getByRole('menu', { name: 'Ponuka' }).getByRole('menuitem', { name: /^O aplikácii Doar/ }).click()
  })()])
  await expect(sup.getByRole('heading', { name: 'Podporiť Doar' })).toBeVisible()
  await expect(sup.getByRole('img', { name: /QR kódom/ })).toBeVisible()
  await sup.getByRole('link', { name: 'Prispieť cez PayPal' }).click({ noWaitAfter: true })
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string }).opened)).toBe('https://paypal.me/korgus')
  await sup.close()
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as { origBox?: typeof dialog.showMessageBox; origOpen?: typeof shell.openExternal }
    dialog.showMessageBox = g.origBox!
    shell.openExternal = g.origOpen!
  })

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
