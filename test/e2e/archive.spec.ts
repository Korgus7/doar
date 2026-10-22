import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAccountViaWizard, launchApp, testServer } from './helpers'
import { encodeMessage } from '../../src/core/export/mboxrd'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const msg = (subject: string, body: string): Buffer =>
  Buffer.from(`From: Jan <jan@firma.sk>\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@firma.sk>\r\nDate: Wed, 01 Oct 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`, 'utf8')

const withAttachment = Buffer.from(
  [
    'From: Eva <eva@firma.sk>',
    'Subject: Zmluva',
    'Message-ID: <zmluva-e2e@firma.sk>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'V prílohe zmluva.',
    '--b1',
    'Content-Type: application/pdf; name="zmluva.pdf"',
    'Content-Disposition: attachment; filename="zmluva.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('PDF obsah').toString('base64'),
    '--b1--',
    ''
  ].join('\r\n')
)

test('lokálny archív: otvorenie, priečinky, čítanie len na čítanie, vyhľadávanie, príloha, zatvorenie', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'doar-e2e-archive-'))
  const file = join(dir, 'Stara-posta.mbox')
  const meta = { source: 'jan@firma.sk', internalDate: new Date('2026-09-01T08:00:00Z') }
  writeFileSync(
    file,
    Buffer.concat([
      encodeMessage(msg('Faktúra september', 'Faktúra v prílohe nie je.'), { ...meta, folderSegments: ['INBOX'], specialUse: '\\Inbox', flags: new Set(['\\Seen']) }).chunk,
      encodeMessage(withAttachment, { ...meta, folderSegments: ['INBOX'], specialUse: '\\Inbox', flags: new Set() }).chunk,
      encodeMessage(msg('Projektová porada', 'Zápis z porady.'), { ...meta, folderSegments: ['Projekty', '2026'], specialUse: null, flags: new Set(['\\Seen']) }).chunk
    ])
  )
  const hash = (): string => createHash('sha256').update(readFileSync(file)).digest('hex')
  const before = hash()

  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, 'cyril')

  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, file)
  await app.evaluate(({ Menu }) => {
    const f = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Súbor')
    f?.submenu?.items.find((i) => i.label === 'Otvoriť archív…')?.click()
  })

  // Archív v ľavom paneli s priečinkami podľa metadát; po načítaní sa otvorí prvý priečinok.
  const nav = win.getByRole('navigation', { name: 'Priečinky' })
  const section = nav.getByRole('region', { name: 'Archív: Stara-posta.mbox' })
  await expect(section.getByRole('button', { name: /Doručená pošta/ })).toBeVisible({ timeout: 30_000 })
  await expect(section.getByRole('button', { name: /Projekty \/ 2026/ })).toBeVisible()
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  await expect(list.getByRole('option')).toHaveCount(2)

  // Čítanie: len na čítanie, príloha, odpoveď je možná; otvorenie neprečítanej správy ju nezmení.
  await list.getByRole('option', { name: /Zmluva/ }).click()
  const reader = win.getByRole('region', { name: 'Čítanie správy' })
  await expect(reader.getByText('Archív – len na čítanie')).toBeVisible()
  await expect(reader.frameLocator('iframe').getByText('V prílohe zmluva.')).toBeVisible()
  await expect(reader.getByRole('button', { name: /zmluva\.pdf/ })).toBeVisible()
  await expect(reader.getByRole('button', { name: /Odpovedať/ }).first()).toBeVisible()
  await expect(reader.getByRole('button', { name: 'Odstrániť' })).toHaveCount(0)
  await win.screenshot({ path: 'test-results/archiv.png' })

  // Kontextová ponuka: žiadne presuny ani mazanie.
  await list.getByRole('option', { name: /Zmluva/ }).click({ button: 'right' })
  const menu = win.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: /Odpovedať/ }).first()).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Kôš|Odstrániť/ })).toHaveCount(0)
  await win.keyboard.press('Escape')

  // Vyhľadávanie v celom archíve bez diakritiky.
  await win.getByRole('searchbox', { name: 'Hľadať v pošte' }).fill('porada')
  await expect(list.getByRole('option')).toHaveCount(1, { timeout: 10_000 })
  await expect(list.getByRole('option', { name: /Projektová porada/ })).toBeVisible()
  await expect(win.getByRole('combobox', { name: 'Kde hľadať' })).toHaveValue('all')

  // Zatvorenie: archív zmizne, súbor zostane nezmenený.
  win.once('dialog', (d) => void d.accept())
  await section.getByRole('button', { name: /Zavrieť archív/ }).click()
  await expect(section).toHaveCount(0)
  expect(hash()).toBe(before)
  await app.close()
})
