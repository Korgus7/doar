import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

test('adresár: nový kontakt, hľadanie, import vCard, export CSV, napísať správu', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'doar-e2e-kontakty-'))
  const vcf = join(dir, 'kontakty.vcf')
  writeFileSync(vcf, 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ľubica Šťastná\r\nEMAIL:lubica@stastna.sk\r\nTEL:+421 905 111 222\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bez adresy\r\nEND:VCARD\r\n')
  const csv = join(dir, 'export.csv')

  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 760 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, 'cyril')

  await win.getByRole('button', { name: 'Adresár' }).click()
  const dlg = win.getByRole('dialog', { name: 'Adresár' })
  await expect(dlg.getByText('Adresár je prázdny', { exact: false })).toBeVisible()

  // Nový kontakt; neplatná adresa sa neuloží.
  await dlg.getByRole('button', { name: 'Nový kontakt' }).click()
  await dlg.getByLabel('Meno').fill('Ján Novák')
  await dlg.getByLabel('E-mail').fill('jan@firma')
  await dlg.getByLabel('Firma').fill('Firma s.r.o.')
  await dlg.getByRole('button', { name: 'Uložiť' }).click()
  await expect(dlg.getByRole('alert')).toHaveText('Zadajte platnú e‑mailovú adresu.')
  await dlg.getByLabel('E-mail').fill('jan@firma.sk')
  await dlg.getByRole('button', { name: 'Uložiť' }).click()
  await expect(dlg.getByRole('status')).toHaveText('Kontakt je uložený.')
  const list = dlg.getByRole('list', { name: 'Kontakty' })
  await expect(list.getByRole('button', { name: /Ján Novák/ })).toBeVisible()

  // Import vCard (kontakt bez adresy sa preskočí).
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, vcf)
  await dlg.getByRole('button', { name: 'Importovať…' }).click()
  await expect(dlg.getByRole('status')).toHaveText('Import: nové 2, doplnené 0, prázdne preskočené 0.')
  await expect(list.getByRole('button')).toHaveCount(3)
  await expect(dlg.getByRole('tab', { name: /Kontakty/ })).toContainText('3')

  // Hľadanie bez diakritiky.
  await dlg.getByLabel('Hľadať v adresári').fill('stastna')
  await expect(list.getByRole('button')).toHaveCount(1)
  await list.getByRole('button', { name: /Ľubica Šťastná/ }).click()
  await expect(dlg.getByLabel('Telefón')).toHaveValue('+421 905 111 222')
  // Poštová adresa a kopírovanie na obálku.
  await dlg.getByLabel('Poštová adresa').fill('Hlavná 12\n902 01 Pezinok')
  await dlg.getByRole('button', { name: 'Uložiť' }).click()
  await expect(dlg.getByRole('status')).toHaveText('Kontakt je uložený.')
  await dlg.getByRole('button', { name: 'Kopírovať adresu' }).click()
  await expect(dlg.getByRole('status')).toContainText('Meno a adresa sú skopírované')
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Ľubica Šťastná\nHlavná 12\n902 01 Pezinok')
  await dlg.getByLabel('Firma').focus()
  await win.screenshot({ path: 'test-results/adresar.png' })

  // Napísať správu → okno so zadaným adresátom.
  const [cw] = await Promise.all([app.waitForEvent('window'), dlg.getByRole('button', { name: 'Napísať správu' }).click()])
  await expect(cw.getByLabel('Komu')).toHaveValue('Ľubica Šťastná <lubica@stastna.sk>', { timeout: 15_000 })
  await cw.close()

  // Export CSV.
  await dlg.getByLabel('Hľadať v adresári').fill('')
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog
  }, csv)
  await dlg.getByRole('button', { name: 'Exportovať…' }).click()
  await win.getByRole('menuitem', { name: /Ako CSV/ }).click()
  await expect(dlg.getByRole('status')).toHaveText('Exportované kontakty: 3.')
  const out = readFileSync(csv, 'utf8')
  expect(out).toContain('First Name,Last Name,E-mail Address,Mobile Phone,Company,Home Street,Notes')
  expect(out).toContain('Ján,Novák,jan@firma.sk,,Firma s.r.o.,,')
  expect(out).toContain('Ľubica,Šťastná,lubica@stastna.sk,+421 905 111 222,,"Hlavná 12\n902 01 Pezinok",')

  // Odstránenie s potvrdením.
  await list.getByRole('button', { name: /Ján Novák/ }).click()
  win.once('dialog', (d) => void d.accept())
  await dlg.getByRole('button', { name: 'Odstrániť' }).click()
  await expect(dlg.getByRole('status')).toHaveText('Kontakt je odstránený.')
  await expect(list.getByRole('button')).toHaveCount(2)

  await win.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  await app.close()
})
