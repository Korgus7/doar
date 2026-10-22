import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAccountViaWizard, launchApp, testServer } from './helpers'
import { encodeMessage } from '../../src/core/export/mboxrd'

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
