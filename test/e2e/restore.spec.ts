import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAccountViaWizard, launchApp, testServer } from './helpers'
import { encodeMessage } from '../../src/core/export/mboxrd'
import { dbxFolders, dbxMessages } from '../fixtures/dbx-writer'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const msg = (subject: string): Buffer =>
  Buffer.from(`From: Jan <jan@firma.sk>\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@firma.sk>\r\nDate: Wed, 01 Oct 2026 09:00:00 +0000\r\n\r\nText ${subject}\r\n`, 'utf8')

test('obnova zo zálohy cez rozhranie: výber súboru, priebeh, súhrn, opakovaná obnova bez duplicít', async () => {
  test.setTimeout(150_000)
  const dir = mkdtempSync(join(tmpdir(), 'doar-e2e-restore-'))
  const file = join(dir, 'Doar-adam.mbox')
  const meta = { source: 'adam@doar.test', internalDate: new Date('2026-09-01T08:00:00Z') }
  writeFileSync(
    file,
    Buffer.concat([
      encodeMessage(msg('Obnovená prvá'), { ...meta, folderSegments: ['INBOX'], specialUse: '\\Inbox', flags: new Set(['\\Seen']) }).chunk,
      encodeMessage(msg('Obnovená druhá'), { ...meta, folderSegments: ['INBOX'], specialUse: '\\Inbox', flags: new Set(['\\Flagged']) }).chunk,
      encodeMessage(msg('Projektová'), { ...meta, folderSegments: ['Projekty', '2026'], specialUse: null, flags: new Set() }).chunk
    ])
  )

  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, 'beata')

  // Natívny dialóg „Otvoriť“ nahradíme – vráti pripravený súbor.
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, file)
  const openRestore = (): Promise<void> =>
    app.evaluate(({ Menu }) => {
      const f = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Súbor')
      f?.submenu?.items.find((i) => i.label === 'Obnoviť zo zálohy…')?.click()
    })

  await openRestore()
  const dlg = win.getByRole('dialog', { name: 'Obnoviť zo zálohy' })
  await expect(dlg.getByText('Existujúca pošta na serveri sa neprepisuje ani nemaže.')).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Začať obnovu' })).toBeDisabled()
  await dlg.getByRole('button', { name: 'Vybrať súbor zálohy…' }).click()
  await expect(dlg.getByText('Záloha z Doaru – konto adam@doar.test')).toBeVisible()
  await expect(dlg.getByLabel('Do pôvodných priečinkov (chýbajúce sa vytvoria)')).toBeChecked()
  await win.screenshot({ path: 'test-results/obnova-start.png' })
  await dlg.getByRole('button', { name: 'Začať obnovu' }).click()

  await expect(dlg.getByText('Obnova dokončená')).toBeVisible({ timeout: 60_000 })
  await expect(dlg.getByRole('row', { name: /Doručená pošta\s+2\s+2\s+0/ })).toBeVisible()
  await expect(dlg.getByRole('row', { name: /Projekty \/ 2026\s+1\s+1\s+0/ })).toBeVisible()
  await win.screenshot({ path: 'test-results/obnova-suhrn.png' })
  await dlg.getByRole('button', { name: 'Zavrieť' }).click()
  await expect(dlg).toBeHidden()

  // Správy sú v zozname (synchronizácia po obnove) a nový priečinok v ľavom paneli.
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  await expect(list.getByRole('option')).toHaveCount(2, { timeout: 30_000 })
  await expect(list.getByRole('option', { name: /Obnovená druhá/ })).toBeVisible()
  await expect(win.getByRole('navigation', { name: 'Priečinky' }).getByText('2026')).toBeVisible()

  // Opakovaná obnova: nič sa nenahrá znova.
  await openRestore()
  await dlg.getByRole('button', { name: 'Vybrať súbor zálohy…' }).click()
  await dlg.getByRole('button', { name: 'Začať obnovu' }).click()
  await expect(dlg.getByText('Obnova dokončená')).toBeVisible({ timeout: 60_000 })
  await expect(dlg.getByRole('row', { name: /Doručená pošta\s+2\s+0\s+2/ })).toBeVisible()
  await expect(dlg.getByText('„Už boli“', { exact: false })).toBeVisible()
  await dlg.getByRole('button', { name: 'Zavrieť' }).click()
  await expect(list.getByRole('option')).toHaveCount(2)
  await app.close()
})

test('import z Outlook Expressu cez ponuku ☰: výber priečinka, náhľad, štandardné priečinky', async () => {
  test.setTimeout(150_000)
  const dir = mkdtempSync(join(tmpdir(), 'doar-e2e-oe-'))
  writeFileSync(
    join(dir, 'Folders.dbx'),
    dbxFolders([
      { id: 1, parent: 0, name: 'Miestne priečinky' },
      { id: 2, parent: 1, name: 'Doručená pošta', file: 'Doručená pošta.dbx' },
      { id: 3, parent: 2, name: 'Rodina', file: 'Rodina.dbx' }
    ])
  )
  writeFileSync(join(dir, 'Doručená pošta.dbx'), dbxMessages([{ raw: msg('Stará pošta 1'), flags: 0x80 }, { raw: msg('Stará pošta 2') }]))
  writeFileSync(join(dir, 'Rodina.dbx'), dbxMessages([{ raw: msg('Fotky z výletu'), flags: 0x80 }]))

  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, 'quido')
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, dir)

  await win.getByRole('button', { name: 'Ponuka' }).click()
  await win.getByRole('menu', { name: 'Ponuka' }).getByRole('menuitem', { name: 'Importovať z iného programu…' }).click()
  const dlg = win.getByRole('dialog', { name: 'Import z iného programu' })
  await dlg.getByRole('button', { name: 'Vybrať priečinok s poštou…' }).click()
  await expect(dlg.getByText('Outlook Express · priečinky: 2 · správy: 3')).toBeVisible()
  await expect(dlg.getByLabel('Do pôvodných priečinkov (chýbajúce sa vytvoria)')).toBeChecked()
  await win.screenshot({ path: 'test-results/import-oe-start.png' })
  await dlg.getByRole('button', { name: 'Začať import' }).click()
  await expect(dlg.getByText('Import dokončený')).toBeVisible({ timeout: 60_000 })
  await expect(dlg.getByRole('row', { name: /^Doručená pošta\s+2\s+2\s+0/ })).toBeVisible()
  await expect(dlg.getByRole('row', { name: /Doručená pošta \/ Rodina\s+1\s+1\s+0/ })).toBeVisible()
  await win.screenshot({ path: 'test-results/import-oe-suhrn.png' })
  await dlg.getByRole('button', { name: 'Zavrieť' }).click()
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  await expect(list.getByRole('option')).toHaveCount(2, { timeout: 30_000 })
  await expect(win.getByRole('navigation', { name: 'Priečinky' }).getByText('Rodina')).toBeVisible()
  await app.close()
})

test('import: server odmietne prihlásenie → zadanie hesla priamo v okne importu a pokračovanie', async () => {
  test.setTimeout(150_000)
  const dir = mkdtempSync(join(tmpdir(), 'doar-e2e-oe-heslo-'))
  writeFileSync(join(dir, 'Folders.dbx'), dbxFolders([{ id: 1, parent: 0, name: 'Doručená pošta', file: 'Doručená pošta.dbx' }]))
  writeFileSync(join(dir, 'Doručená pošta.dbx'), dbxMessages([{ raw: msg('Po zadaní hesla'), flags: 0x80 }]))

  // Heslo len do zatvorenia aplikácie (Linux bez kľúčenky) → po novom spustení chýba.
  const first = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win1 = await first.app.firstWindow()
  await win1.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win1, srv!, 'viera')
  await first.app.close()

  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8', DOAR_DATA_DIR: first.dataDir })
  const win = await app.firstWindow()
  await expect(win.getByRole('navigation', { name: 'Priečinky' })).toBeVisible({ timeout: 30_000 })
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, dir)
  await win.getByRole('button', { name: 'Ponuka' }).click()
  await win.getByRole('menu', { name: 'Ponuka' }).getByRole('menuitem', { name: 'Importovať z iného programu…' }).click()
  const dlg = win.getByRole('dialog', { name: 'Import z iného programu' })
  await dlg.getByRole('button', { name: 'Vybrať priečinok s poštou…' }).click()
  await dlg.getByRole('button', { name: 'Začať import' }).click()
  await expect(dlg.getByText('Doar nemá uložené heslo ku kontu viera@doar.test', { exact: false })).toBeVisible({ timeout: 60_000 })
  await expect(dlg.getByText('Import sa zastavil', { exact: false })).toBeVisible()
  await dlg.getByLabel('Heslo').fill(srv!.password)
  await win.screenshot({ path: 'test-results/import-heslo.png' })
  await dlg.getByRole('button', { name: 'Uložiť heslo a pokračovať' }).click()
  await expect(dlg.getByText('Import dokončený')).toBeVisible({ timeout: 60_000 })
  await expect(dlg.getByRole('row', { name: /^Doručená pošta\s+1\s+1\s+0/ })).toBeVisible()
  await app.close()
})
