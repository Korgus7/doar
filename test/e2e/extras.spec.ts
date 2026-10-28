import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

/** Verzia 0.9: odhlásenie z odberu, okno správy, PDF/.eml, označiť priečinok, pravidlá, šablóny, odoslať neskôr. */

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'carol'
/** Druhý test má vlastné konto (každý test začína s čistou schránkou aj pri opakovaní). */
const USER2 = 'rado'

const imap = (user = USER): ImapFlow =>
  new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${user}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })

async function onServer(path: string, user = USER): Promise<string[]> {
  const c = imap(user)
  await c.connect()
  try {
    const lock = await c.getMailboxLock(path)
    try {
      if (!c.mailbox || !c.mailbox.exists) return []
      const out: string[] = []
      for await (const m of c.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '')
      return out
    } finally {
      lock.release()
    }
  } finally {
    await c.logout().catch(() => {})
  }
}

const mail = (subject: string, from: string, extra = '', to = USER): Buffer =>
  Buffer.from(
    `From: ${from}\r\nTo: ${to}@doar.test\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@test>\r\nDate: ${new Date().toUTCString()}\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nText správy: ${subject}\r\n`
  )

/** Čistá doručená pošta s danými správami (aj pri opakovaní testu). */
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
    for (const m of list) await c.append('INBOX', m, [])
  } finally {
    await c.logout()
  }
}

async function start(user: string): Promise<{ app: Awaited<ReturnType<typeof launchApp>>['app']; win: Page }> {
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 780 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, user)
  return { app, win }
}

test('správa: označiť všetko ako prečítané, odhlásiť z odberu, samostatné okno, PDF a .eml', async () => {
  test.setTimeout(180_000)
  await seed(USER, [
    mail('Novinky týždňa', 'Obchod Šťastný <novinky@obchod.sk>', `List-Unsubscribe: <mailto:${USER}@doar.test?subject=odhlasit-z-odberu>\r\n`),
    mail('Pracovná porada', 'Ján Novák <jan@firma.sk>'),
    mail('Faktúra 2026/10', 'Účtovníčka <uctovnictvo@firma.sk>')
  ])
  const { app, win } = await start(USER)
  const dir = mkdtempSync(join(tmpdir(), 'doar-e2e-extras-'))
  const folders = win.getByRole('navigation', { name: 'Priečinky' })
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  const row = (s: string) => list.getByRole('option', { name: new RegExp(s) })
  const reader = win.getByRole('region', { name: 'Čítanie správy' })
  await folders.getByRole('button', { name: /^Doručená pošta/ }).click()
  await expect(list.getByRole('option')).toHaveCount(3, { timeout: 30_000 })

  // Pravý klik na priečinok → Označiť všetko ako prečítané.
  await folders.getByRole('button', { name: /^Doručená pošta/ }).click({ button: 'right' })
  await win.getByRole('menu').getByRole('menuitem', { name: 'Označiť všetko ako prečítané' }).click()
  await expect(win.getByText('Označené ako prečítané: 3')).toBeVisible()

  // Odhlásenie z odberu (mailto) – s potvrdením; žiadosť odíde e‑mailom.
  await row('Novinky týždňa').click()
  await expect(reader.getByRole('heading', { name: 'Novinky týždňa' })).toBeVisible()
  win.once('dialog', (d) => {
    expect(d.message()).toContain('Obchod Šťastný')
    void d.accept()
  })
  await reader.getByRole('button', { name: 'Odhlásiť z odberu' }).click()
  await expect(win.getByText('E‑mail so žiadosťou o odhlásenie je vo fronte na odoslanie.')).toBeVisible()
  await win.screenshot({ path: 'test-results/odhlasit-z-odberu.png' })
  await expect.poll(() => onServer('INBOX'), { timeout: 30_000 }).toContain('odhlasit-z-odberu')

  // Uložiť ako PDF a ako .eml (dialóg „Uložiť ako“ nahradený).
  const pdf = join(dir, 'novinky.pdf')
  const eml = join(dir, 'novinky.eml')
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog
  }, pdf)
  await reader.getByRole('button', { name: 'Ďalšie' }).click()
  await win.getByRole('menu').getByRole('menuitem', { name: 'Uložiť ako PDF…' }).click()
  await expect(win.getByText('PDF je uložené.')).toBeVisible({ timeout: 20_000 })
  expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-')
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog
  }, eml)
  await reader.getByRole('button', { name: 'Ďalšie' }).click()
  await win.getByRole('menu').getByRole('menuitem', { name: /Uložiť správu ako súbor/ }).click()
  await expect(win.getByText('Správa je uložená: novinky.eml')).toBeVisible()
  expect(readFileSync(eml, 'utf8')).toContain('List-Unsubscribe: <mailto:')

  // Dvojklik → samostatné okno; Escape ho zavrie.
  const [mw] = await Promise.all([app.waitForEvent('window'), row('Pracovná porada').dblclick()])
  await expect(mw.getByRole('heading', { name: 'Pracovná porada' })).toBeVisible({ timeout: 15_000 })
  await expect(mw).toHaveTitle(/Pracovná porada/)
  await expect(mw.getByRole('button', { name: /Odpovedať$/ })).toBeVisible()
  await mw.screenshot({ path: 'test-results/okno-spravy.png' })
  // Hviezdička v okne správy sa prejaví aj v hlavnom okne.
  await mw.getByRole('button', { name: 'Označiť hviezdičkou' }).click()
  await expect(row('Pracovná porada').getByRole('button', { name: 'Zrušiť hviezdičku' })).toBeVisible()
  await expect(mw.getByRole('button', { name: 'Zrušiť hviezdičku' })).toBeVisible()
  // Escape zavrie okno ešte počas stlačenia klávesu.
  await mw.keyboard.press('Escape').catch(() => {})
  await expect.poll(() => mw.isClosed()).toBe(true)

  // Súbor .eml (napr. príloha z inej pošty) – otvorí sa v okne len na čítanie.
  const other = join(dir, 'z-disku.eml')
  writeFileSync(other, mail('Správa zo súboru', 'Niekto <niekto@inde.sk>'))
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, other)
  await win.getByRole('button', { name: 'Ponuka' }).click()
  const [ew] = await Promise.all([app.waitForEvent('window'), win.getByRole('menu').getByRole('menuitem', { name: /Otvoriť správu zo súboru/ }).click()])
  await expect(ew.getByRole('heading', { name: 'Správa zo súboru' })).toBeVisible({ timeout: 15_000 })
  await expect(ew.getByText('Súbor .eml – len na čítanie')).toBeVisible()
  await ew.close()
  await app.close()
})

test('pravidlá, šablóny a odoslať neskôr', async () => {
  test.setTimeout(180_000)
  await seed(USER2, [mail('Faktúra 2026/10', 'Účtovníčka <uctovnictvo@firma.sk>', '', USER2), mail('Pozdrav', 'Ján Novák <jan@firma.sk>', '', USER2)])
  const { app, win } = await start(USER2)
  const folders = win.getByRole('navigation', { name: 'Priečinky' })
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  const row = (s: string) => list.getByRole('option', { name: new RegExp(s) })
  const reader = win.getByRole('region', { name: 'Čítanie správy' })
  await folders.getByRole('button', { name: /^Doručená pošta/ }).click()
  await expect(row('Faktúra 2026')).toBeVisible({ timeout: 30_000 })

  // Pravidlo zo správy: odosielateľ je predvyplnený.
  await row('Faktúra 2026').click()
  await reader.getByRole('button', { name: 'Ďalšie' }).click()
  await win.getByRole('menu').getByRole('menuitem', { name: /Vytvoriť pravidlo/ }).click()
  const dlg = win.getByRole('dialog', { name: 'Nastavenia' })
  await expect(dlg.getByRole('tab', { name: 'Pravidlá' })).toHaveAttribute('aria-selected', 'true')
  await expect(dlg.getByLabel('obsahuje')).toHaveValue('uctovnictvo@firma.sk')
  await dlg.getByLabel('potom').selectOption({ label: 'označiť hviezdičkou' })
  await dlg.getByLabel('Názov (nepovinné)').fill('Faktúry')
  await dlg.getByRole('button', { name: 'Uložiť pravidlo' }).click()
  await expect(dlg.getByRole('status')).toHaveText('Pravidlo je uložené.')
  await expect(dlg.getByRole('list', { name: 'Pravidlá pre novú poštu' }).getByText('Faktúry')).toBeVisible()
  await dlg.getByRole('button', { name: 'Použiť teraz' }).click()
  await expect(dlg.getByRole('status')).toHaveText('Pravidlá sa použili na správy: 1')
  await win.screenshot({ path: 'test-results/pravidla.png' })
  await win.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  await expect(row('Faktúra 2026').getByRole('button', { name: 'Zrušiť hviezdičku' })).toBeVisible()

  // Šablóna: uložiť text z jednej správy, vložiť do druhej.
  const openCompose = async (): Promise<Page> => {
    const [w] = await Promise.all([app.waitForEvent('window'), win.getByRole('button', { name: /Nová správa/ }).click()])
    await expect(w.getByRole('button', { name: /^Odoslať/ })).toBeEnabled()
    return w
  }
  const c1 = await openCompose()
  await c1.getByLabel('Predmet').fill('Potvrdenie objednávky')
  await c1.getByLabel('Text správy').fill('Dobrý deň, potvrdzujeme prijatie objednávky.')
  await c1.getByRole('button', { name: 'Šablóny' }).click()
  await c1.getByLabel('Názov šablóny').fill('Potvrdenie')
  await c1.getByRole('button', { name: 'Uložiť túto správu ako šablónu' }).click()
  await expect(c1.getByText('Šablóna „Potvrdenie“ je uložená.')).toBeVisible()
  c1.once('dialog', (d) => void d.accept())
  await c1.getByRole('button', { name: /Zahodiť/ }).click()
  await expect.poll(() => c1.isClosed()).toBe(true)

  const c2 = await openCompose()
  await c2.getByRole('button', { name: 'Šablóny' }).click()
  await c2.getByRole('region', { name: 'Šablóny' }).getByRole('button', { name: /^Potvrdenie/ }).click()
  await expect(c2.getByLabel('Predmet')).toHaveValue('Potvrdenie objednávky')
  await expect(c2.getByLabel('Text správy')).toContainText('potvrdzujeme prijatie objednávky')

  // Odoslať neskôr → v hlavnom okne čaká; zrušenie ju vráti medzi koncepty.
  await c2.getByLabel('Komu').fill(`${USER2}@doar.test`)
  await c2.getByRole('button', { name: 'Naplánovať odoslanie…' }).click()
  await c2.getByRole('button', { name: 'Zajtra ráno' }).click()
  await c2.screenshot({ path: 'test-results/odoslat-neskor.png' })
  await c2.getByRole('button', { name: 'Naplánovať', exact: true }).click()
  await expect.poll(() => c2.isClosed()).toBe(true)
  const banner = win.getByRole('region', { name: 'Odosielanie' })
  await expect(banner.getByText(/„Potvrdenie objednávky“ sa odošle/)).toBeVisible()
  win.once('dialog', (d) => void d.accept())
  await banner.getByRole('button', { name: 'Zrušiť odoslanie' }).click()
  await expect(win.getByText('„Potvrdenie objednávky“ je späť medzi konceptmi.')).toBeVisible()
  await folders.getByRole('button', { name: /^Koncepty/ }).click()
  await expect(row('Potvrdenie objednávky')).toBeVisible({ timeout: 30_000 })
  expect(await onServer('INBOX', USER2)).not.toContain('Potvrdenie objednávky')
  await app.close()
})
