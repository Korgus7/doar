import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'emil'

function imap(): ImapFlow {
  return new ImapFlow({
    host: '127.0.0.1',
    port: srv!.ports.imaps,
    secure: true,
    auth: { user: `${USER}@doar.test`, pass: srv!.password },
    tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) },
    logger: false
  })
}

const plain = (subject: string, body: string, from = 'Ján Novák <jan@firma.sk>') =>
  Buffer.from(`From: ${from}\r\nTo: ${USER}@doar.test\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`)

const html = Buffer.from(
  [
    'From: Obchod <news@shop.sk>',
    `To: ${USER}@doar.test`,
    'Subject: =?UTF-8?Q?Jesenn=C3=A1_akcia?=',
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<h1 id="nadpis">Jesenná akcia</h1><p>Zľavy až 30 %.</p>',
    '<img id="pixel" src="https://tracker.example.com/p.gif">',
    '<script>document.title="NAPADNUTE"</script><a id="odkaz" href="https://shop.sk/akcia">Pozrieť</a>'
  ].join('\r\n')
)

test.beforeAll(async () => {
  const c = imap()
  await c.connect()
  await c.mailboxCreate(['Faktúry', '2026'])
  await c.append('INBOX', plain('Pozvánka na stretnutie', 'Ahoj,\nstretneme sa v piatok o 10:00?\nhttps://kalendar.sk/udalost'), [])
  await c.append('INBOX', html, [])
  await c.append('INBOX', plain('Staršia prečítaná', 'Text'), ['\\Seen'])
  await c.append('Faktúry/2026', plain('Faktúra 2026/015', 'Suma: 99 €'), [])
  await c.logout()
})

test('hlavné okno: priečinky, zoznam, čítanie, bezpečné HTML, prečítané, nová pošta cez IDLE', async () => {
  test.setTimeout(150_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 760 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, USER)

  const folders = win.getByRole('navigation', { name: 'Priečinky' })
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })

  // Priečinky so slovenskými názvami, vnorený priečinok s diakritikou.
  await expect(folders.getByRole('button', { name: /^Doručená pošta/ })).toBeVisible({ timeout: 30_000 })
  for (const name of ['Odoslané', 'Koncepty', 'Kôš', 'Spam', 'Archív', 'Faktúry', '2026']) {
    await expect(folders.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
  }

  // Spoločná doručená pošta: 3 správy, 2 neprečítané.
  await expect(list.getByRole('option')).toHaveCount(3, { timeout: 30_000 })
  await expect(folders.getByRole('button', { name: /Všetka doručená pošta\s*2/ })).toBeVisible()
  await win.screenshot({ path: 'test-results/hlavne-okno.png' })

  // Otvorenie textovej správy: obsah, klikateľný odkaz, označenie ako prečítané (aj na serveri).
  await list.getByRole('option', { name: /Pozvánka na stretnutie/ }).click()
  const reader = win.getByRole('region', { name: 'Čítanie správy' })
  await expect(reader.getByRole('heading', { name: 'Pozvánka na stretnutie' })).toBeVisible()
  const body = win.frameLocator('iframe')
  await expect(body.getByText('stretneme sa v piatok', { exact: false })).toBeVisible()
  await expect(body.getByRole('link', { name: 'https://kalendar.sk/udalost' })).toBeVisible()
  await expect(folders.getByRole('button', { name: /Všetka doručená pošta\s*1/ })).toBeVisible({ timeout: 15_000 })

  // HTML správa: skript nebeží, vzdialený obrázok blokovaný, upozornenie zobrazené.
  await list.getByRole('option', { name: /Jesenná akcia/ }).click()
  await expect(body.locator('#nadpis')).toHaveText('Jesenná akcia')
  await expect(reader.getByText('Vzdialené obrázky sú zablokované', { exact: false })).toBeVisible()
  expect(await body.locator('#pixel').getAttribute('src')).toBeFalsy() // adresa sledovacieho obrázka je preč
  expect(await body.locator('script').count()).toBe(0)
  expect(await win.title()).not.toBe('NAPADNUTE')
  await win.screenshot({ path: 'test-results/citanie-html.png' })

  // Kliknutie na odkaz nesmie otvoriť nič v aplikácii (ide do systémového prehliadača).
  const windowsBefore = app.windows().length
  await body.getByRole('link', { name: 'Pozrieť' }).click()
  await win.waitForTimeout(300)
  expect(app.windows().length).toBe(windowsBefore)
  await expect(reader.getByRole('heading', { name: 'Jesenná akcia' })).toBeVisible()

  // Prečítanie sa uložilo na server (overenie iným klientom).
  const c = imap()
  await c.connect()
  const lock = await c.getMailboxLock('INBOX')
  try {
    await expect
      .poll(async () => {
        const uids = (await c.search({ seen: false }, { uid: true })) || []
        return uids.length
      }, { timeout: 15_000 })
      .toBe(0)
  } finally {
    lock.release()
  }

  // Nová správa doručená počas behu sa objaví sama (IDLE), bez stlačenia Synchronizovať.
  await c.append('INBOX', plain('Práve prišlo', 'Nová správa'), [])
  await c.logout()
  await expect(list.getByRole('option', { name: /Práve prišlo/ })).toBeVisible({ timeout: 20_000 })

  // Vnorený priečinok.
  await folders.getByRole('button', { name: /^2026/ }).click()
  await expect(list.getByRole('option')).toHaveCount(1)
  await expect(list.getByRole('option', { name: /Faktúra 2026\/015/ })).toBeVisible()

  // Klávesnica: šípky v zozname.
  await folders.getByRole('button', { name: /^Doručená pošta/ }).click()
  await expect(list.getByRole('option', { name: /Pozvánka na stretnutie/ })).toBeVisible()
  await list.focus()
  await win.keyboard.press('ArrowDown')
  await expect(list.getByRole('option', { selected: true })).toHaveCount(1)

  await win.screenshot({ path: 'test-results/hlavne-okno-koniec.png' })
  await app.close()
})
