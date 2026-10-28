import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

/** Verzia 0.9 (druhá časť): konverzácie, rozšírené hľadanie, náhľad príloh, podpisy s logom, skupiny v adresári. */

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'xaver'
const USER2 = 'yvona'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
).toString('base64')

const imap = (user: string): ImapFlow =>
  new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${user}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })

async function seed(user: string, list: Buffer[]): Promise<void> {
  const c = imap(user)
  await c.connect()
  try {
    const lock = await c.getMailboxLock('INBOX')
    try {
      if (c.mailbox && c.mailbox.exists) await c.messageDelete('1:*')
    } finally {
      lock.release()
    }
    for (const m of list) await c.append('INBOX', m, ['\\Seen'])
  } finally {
    await c.logout()
  }
}

async function sources(user: string): Promise<string[]> {
  const c = imap(user)
  await c.connect()
  const out: string[] = []
  try {
    const lock = await c.getMailboxLock('INBOX')
    try {
      if (c.mailbox && c.mailbox.exists) for await (const m of c.fetch('1:*', { source: true })) out.push(m.source!.toString())
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
  return out
}

const b64 = (s: string): string => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`
function plain(to: string, subject: string, opts: { id?: string; reply?: string; from?: string; day?: number } = {}): Buffer {
  return Buffer.from(
    `From: ${opts.from ?? 'Ján Novák <jan@firma.sk>'}\r\nTo: ${to}@doar.test\r\nSubject: ${b64(subject)}\r\nMessage-ID: ${opts.id ?? `<${Math.random().toString(36).slice(2)}@firma.sk>`}\r\n` +
      `${opts.reply ? `In-Reply-To: ${opts.reply}\r\nReferences: ${opts.reply}\r\n` : ''}Date: ${new Date(Date.now() - (opts.day ?? 0) * 86_400_000).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${subject} – text\r\n`
  )
}
function withAttachments(to: string, subject: string, atts: { name: string; type: string; data: string }[]): Buffer {
  const parts = atts
    .map((a) => `--hr\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${a.data}\r\n`)
    .join('')
  return Buffer.from(
    `From: Eva <eva@firma.sk>\r\nTo: ${to}@doar.test\r\nSubject: ${b64(subject)}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@firma.sk>\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="hr"\r\n\r\n--hr\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nV prílohe.\r\n${parts}--hr--\r\n`
  )
}

async function start(user: string): Promise<{ app: Awaited<ReturnType<typeof launchApp>>['app']; win: Page }> {
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, user)
  return { app, win }
}

test('konverzácie, rozšírené hľadanie a náhľad príloh', async () => {
  test.setTimeout(180_000)
  await seed(USER, [
    plain(USER, 'Plán výletu', { id: '<vylet-1@firma.sk>', day: 2 }),
    plain(USER, 'Re: Plán výletu', { id: '<vylet-2@firma.sk>', reply: '<vylet-1@firma.sk>', from: 'Eva <eva@firma.sk>', day: 1 }),
    plain(USER, 'Iná vec', { day: 3 }),
    withAttachments(USER, 'Fotky a zmluva', [
      { name: 'fotka.png', type: 'image/png', data: PNG },
      { name: 'zmluva.pdf', type: 'application/pdf', data: PDF },
      { name: 'poznamky.txt', type: 'text/plain; charset=utf-8', data: Buffer.from('Prvý riadok\nDruhý riadok').toString('base64') }
    ])
  ])
  const { app, win } = await start(USER)
  const folders = win.getByRole('navigation', { name: 'Priečinky' })
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  const reader = win.getByRole('region', { name: 'Čítanie správy' })
  await folders.getByRole('button', { name: /^Doručená pošta/ }).click()
  await expect(list.getByRole('option')).toHaveCount(4, { timeout: 30_000 })

  // Konverzácie: zapnúť v ponuke ☰ – odpoveď a pôvodná správa sú jeden riadok.
  await win.getByRole('button', { name: 'Ponuka' }).click()
  await win.getByRole('menu').getByRole('menuitem', { name: /Zoskupiť do konverzácií/ }).click()
  await expect(list.getByRole('option')).toHaveCount(3)
  const conv = list.getByRole('option', { name: /Re: Plán výletu/ })
  await expect(conv).toContainText('2')
  await conv.click()
  const thread = reader.getByRole('region', { name: 'Konverzácia' })
  await expect(thread.getByRole('button', { name: 'Konverzácia (2)' })).toBeVisible()
  await expect(reader.getByRole('heading', { name: 'Re: Plán výletu' })).toBeVisible()
  await thread.getByRole('button', { name: /Ján Novák/ }).click()
  await expect(reader.getByRole('heading', { name: 'Plán výletu', exact: true })).toBeVisible()
  await win.screenshot({ path: 'test-results/konverzacie.png' })
  // Vypnúť – opäť štyri riadky.
  await win.getByRole('button', { name: 'Ponuka' }).click()
  await win.getByRole('menu').getByRole('menuitem', { name: /✓ Zoskupiť do konverzácií/ }).click()
  await expect(list.getByRole('option')).toHaveCount(4)

  // Rozšírené hľadanie: len s prílohou (príloha sa zistí po stiahnutí správ – počkáme na sťahovanie).
  await expect.poll(async () => (await list.getByRole('option').filter({ has: win.getByTitle('Obsahuje prílohu') }).count()), { timeout: 30_000 }).toBe(1)
  await win.getByRole('button', { name: 'Rozšírené hľadanie' }).click()
  const adv = win.getByRole('dialog', { name: 'Rozšírené hľadanie' })
  await adv.getByLabel('s prílohou').check()
  await adv.getByRole('button', { name: 'Hľadať' }).click()
  await expect(list.getByRole('option')).toHaveCount(1)
  await expect(list.getByRole('option', { name: /Fotky a zmluva/ })).toBeVisible()
  await expect(win.getByRole('button', { name: 'Rozšírené hľadanie' })).toHaveClass(/active/)
  // Filter v texte: od:eva + neprečítané (všetky sú prečítané) → nič.
  await win.getByRole('button', { name: 'Rozšírené hľadanie' }).click()
  await adv.getByRole('button', { name: 'Zrušiť filtre' }).click()
  await win.getByLabel('Hľadať v pošte').fill('od:eva')
  await win.getByLabel('Hľadať v pošte').press('Enter')
  await expect(list.getByRole('option')).toHaveCount(2)
  await win.getByLabel('Hľadať v pošte').fill('od:eva je:neprecitane')
  await win.getByLabel('Hľadať v pošte').press('Enter')
  await expect(list.getByRole('option')).toHaveCount(0)
  await win.getByLabel('Hľadať v pošte').press('Escape')
  await expect(list.getByRole('option')).toHaveCount(4)

  // Náhľad: obrázok a text v Doare, PDF v okne náhľadu.
  await list.getByRole('option', { name: /Fotky a zmluva/ }).click()
  await reader.getByRole('button', { name: /fotka\.png/ }).click()
  const prev = win.getByRole('dialog', { name: 'Náhľad: fotka.png' })
  await expect(prev.getByRole('img', { name: 'fotka.png' })).toBeVisible()
  await win.screenshot({ path: 'test-results/nahlad-obrazka.png' })
  await win.keyboard.press('Escape')
  await expect(prev).toHaveCount(0)
  await reader.getByRole('button', { name: /poznamky\.txt/ }).click()
  await expect(win.getByRole('dialog', { name: 'Náhľad: poznamky.txt' })).toContainText('Druhý riadok')
  await win.keyboard.press('Escape')
  const [pdfWin] = await Promise.all([app.waitForEvent('window'), reader.getByRole('button', { name: /zmluva\.pdf/ }).click()])
  await expect.poll(() => pdfWin.url()).toMatch(/zmluva\.pdf$/)
  await pdfWin.close()
  await app.close()
})

test('podpisy s logom a skupiny v adresári', async () => {
  test.setTimeout(180_000)
  await seed(USER2, [plain(USER2, 'Ahoj')])
  const { app, win } = await start(USER2)
  const dir = mkdtempSync(join(tmpdir(), 'doar-e2e-sig-'))
  const logo = join(dir, 'logo.png')
  writeFileSync(logo, Buffer.from(PNG, 'base64'))

  // Dva podpisy, prvý s logom.
  await win.getByRole('button', { name: 'Nastavenia', exact: true }).click()
  const dlg = win.getByRole('dialog', { name: 'Nastavenia' })
  await dlg.getByRole('button', { name: 'Nový podpis' }).click()
  await dlg.getByLabel('Názov', { exact: true }).fill('Pracovný')
  await dlg.getByRole('textbox', { name: 'Text podpisu' }).click()
  await win.keyboard.type('Yvona Testová, Firma s.r.o.')
  await win.keyboard.press('Enter')
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, logo)
  await dlg.getByRole('button', { name: 'Vložiť logo…' }).click()
  await expect(dlg.getByRole('textbox', { name: 'Text podpisu' }).locator('img:not(.ProseMirror-separator)')).toHaveCount(1)
  await dlg.getByRole('button', { name: 'Uložiť podpis' }).click()
  await expect(dlg.getByText('Podpis je uložený.')).toBeVisible()
  await dlg.getByRole('button', { name: 'Nový podpis' }).click()
  await dlg.getByLabel('Názov', { exact: true }).fill('Krátky')
  await dlg.getByRole('textbox', { name: 'Text podpisu' }).click()
  await win.keyboard.type('Y. T.')
  await dlg.getByRole('button', { name: 'Uložiť podpis' }).click()
  await expect(dlg.getByRole('radio', { name: 'Pracovný' })).toBeChecked()
  await win.screenshot({ path: 'test-results/podpisy.png' })
  await win.keyboard.press('Escape')

  // Nová správa: predvolený podpis s logom; výber iného podpisu ho vymení.
  const [c] = await Promise.all([app.waitForEvent('window'), win.getByRole('button', { name: /Nová správa/ }).click()])
  const body = c.getByRole('textbox', { name: 'Text správy' })
  await expect(body).toContainText('Firma s.r.o.', { timeout: 15_000 })
  await expect(body.locator('img:not(.ProseMirror-separator)')).toHaveCount(1)
  await c.getByLabel('Podpis').selectOption({ label: 'Krátky' })
  await expect(body).toContainText('Y. T.')
  await expect(body).not.toContainText('Firma s.r.o.')
  await expect(body.locator('img:not(.ProseMirror-separator)')).toHaveCount(0)
  await c.getByLabel('Podpis').selectOption({ label: 'Pracovný' })
  await expect(body.locator('img:not(.ProseMirror-separator)')).toHaveCount(1)
  await c.getByLabel('Komu').fill(`${USER2}@doar.test`)
  await c.getByLabel('Predmet').fill('S logom')
  await Promise.all([c.waitForEvent('close'), c.getByRole('button', { name: /^Odoslať ➤/ }).click()])
  // U príjemcu: logo ako vložený obrázok s Content-ID (Gmail a Outlook obrázky data: nezobrazujú).
  await expect.poll(async () => (await sources(USER2)).find((s) => s.includes('Subject: S logom')) ?? '', { timeout: 30_000 }).toMatch(/Content-ID: <obrazok1\./)
  const sent = (await sources(USER2)).find((s) => s.includes('Subject: S logom'))!
  expect(sent).toMatch(/multipart\/related/)
  expect(sent).toMatch(/src=3D"cid:obrazok1\.|src="cid:obrazok1\./)

  // Skupiny v adresári.
  await win.getByRole('button', { name: 'Adresár' }).click()
  const ab = win.getByRole('dialog', { name: 'Adresár' })
  for (const [name, email] of [
    ['Mama', 'mama@doma.sk'],
    ['Ocko', 'ocko@doma.sk']
  ]) {
    await ab.getByRole('button', { name: 'Nový kontakt' }).click()
    await ab.getByLabel('Meno').fill(name!)
    await ab.getByLabel('E-mail').fill(email!)
    await ab.getByRole('button', { name: 'Uložiť' }).click()
    await expect(ab.getByRole('status')).toHaveText('Kontakt je uložený.')
  }
  await ab.getByRole('button', { name: 'Nová skupina' }).click()
  await ab.getByLabel('Názov skupiny, napr. Rodina').fill('Rodina')
  await ab.getByRole('button', { name: 'Uložiť skupinu' }).click()
  await expect(ab.getByLabel('Skupina')).toHaveValue(/\d+/)
  await expect(ab.getByRole('list', { name: 'Kontakty' }).getByRole('button')).toHaveCount(0)
  // Kontakty pridať do skupiny cez ich formulár.
  await ab.getByLabel('Skupina').selectOption({ label: 'Všetky kontakty' })
  for (const name of ['Mama', 'Ocko']) {
    await ab.getByRole('list', { name: 'Kontakty' }).getByRole('button', { name: new RegExp(name) }).click()
    await ab.getByRole('checkbox', { name: 'Rodina' }).check()
    await ab.getByRole('button', { name: 'Uložiť' }).click()
    await expect(ab.getByRole('status')).toHaveText('Kontakt je uložený.')
  }
  await ab.getByLabel('Skupina').selectOption({ label: 'Rodina (2)' })
  await expect(ab.getByRole('list', { name: 'Kontakty' }).getByRole('button')).toHaveCount(2)
  await win.screenshot({ path: 'test-results/skupiny.png' })
  const [gw] = await Promise.all([app.waitForEvent('window'), ab.getByRole('button', { name: 'Napísať skupine' }).click()])
  await expect(gw.getByLabel('Komu')).toHaveValue('Mama <mama@doma.sk>, Ocko <ocko@doma.sk>', { timeout: 15_000 })
  // Našepkávanie: „rod“ ponúkne skupinu, Enter vloží všetky adresy.
  await gw.getByRole('button', { name: 'Kópia a skrytá kópia' }).click()
  const cc = gw.getByLabel('Kópia', { exact: true })
  await cc.fill('rod')
  await expect(gw.getByRole('option', { name: /Rodina/ })).toBeVisible()
  await cc.press('Enter')
  await expect(cc).toHaveValue('Mama <mama@doma.sk>, Ocko <ocko@doma.sk>, ')
  gw.once('dialog', (d) => void d.accept())
  // Okno sa po kliknutí zavrie – kliknutie môže skončiť chybou „page closed“, rozhoduje zatvorenie okna.
  await Promise.all([gw.waitForEvent('close'), gw.getByRole('button', { name: /Zahodiť/ }).click().catch(() => {})])
  await app.close()
})

test('poradie kont: ponuka a ťahanie myšou', async () => {
  test.setTimeout(120_000)
  const { app, win } = await start(USER)
  await win.getByRole('button', { name: 'Ponuka' }).click()
  await win.getByRole('menu', { name: 'Ponuka' }).getByRole('menuitem', { name: 'Pridať konto…' }).click()
  await addAccountViaWizard(win, srv!, USER2, { openWizard: false })
  const pane = win.getByRole('navigation', { name: 'Priečinky' })
  const names = pane.locator('section.account:not(.archive) h2 .acc-name')
  const order = async (): Promise<number[]> => win.evaluate(async () => ((await (globalThis as unknown as { doar: { invoke(ch: string): Promise<{ id: number }[]> } }).doar.invoke('accounts.list')).map((a) => a.id)))
  await expect(names).toHaveText([`${USER}@doar.test`, `${USER2}@doar.test`])
  const [first, second] = await order()

  // Ponuka konta: prvé konto nemôže vyššie, posunie sa nižšie.
  await names.nth(0).click({ button: 'right' })
  await expect(win.getByRole('menuitem', { name: 'Posunúť konto vyššie' })).toBeDisabled()
  await win.getByRole('menuitem', { name: 'Posunúť konto nižšie' }).click()
  await expect(names).toHaveText([`${USER2}@doar.test`, `${USER}@doar.test`])
  expect(await order()).toEqual([second, first])

  // Ťahanie hlavičky konta na iné konto (pokus sa zopakuje, ak sa ťahanie pri prekresľovaní nezačne).
  await expect(win.getByRole('menu')).toHaveCount(0)
  await expect(async () => {
    await pane.locator('section.account h2').nth(1).dragTo(pane.locator('section.account h2').nth(0))
    await expect(names).toHaveText([`${USER}@doar.test`, `${USER2}@doar.test`], { timeout: 1000 })
  }).toPass({ timeout: 15_000 })
  expect(await order()).toEqual([first, second])
  await app.close()
})
