import { test, expect } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'
import { splitMboxrd, stripDoarBlock } from '../../src/core/export/mboxrd'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

test.beforeAll(async () => {
  const c = new ImapFlow({
    host: '127.0.0.1',
    port: srv!.ports.imaps,
    secure: true,
    auth: { user: 'ivan@doar.test', pass: srv!.password },
    tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) },
    logger: false
  })
  await c.connect()
  await c.mailboxCreate(['Projekty', 'Žltá'])
  for (let i = 1; i <= 5; i++) await c.append('INBOX', Buffer.from(`From: a@b.sk\r\nSubject: Správa ${i}\r\n\r\nFrom the start ${i}\r\n`), i % 2 ? ['\\Seen'] : [])
  await c.append('Projekty/Žltá', Buffer.from('From: a@b.sk\r\nSubject: Projekt\r\n\r\nx\r\n'), ['\\Flagged'])
  await c.logout()
})

test('záloha cez rozhranie: upozornenia, priebeh, súhrn, súbor na disku', async () => {
  test.setTimeout(150_000)
  const outDir = mkdtempSync(join(tmpdir(), 'doar-e2e-backup-'))
  const target = join(outDir, 'moja-zaloha.mbox')
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, 'ivan')
  await expect(win.getByRole('listbox', { name: 'Zoznam správ' }).getByRole('option')).toHaveCount(5, { timeout: 30_000 })

  // Natívny dialóg „Uložiť ako“ nahradíme – vráti pripravenú cestu (bez prípony – Doar ju doplní).
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog
  }, target.replace(/\.mbox$/, ''))

  // Otvorenie z menu Súbor → Zálohovať konto…
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Súbor')
    file?.submenu?.items.find((i) => i.label === 'Zálohovať konto…')?.click()
  })
  const dlg = win.getByRole('dialog', { name: /Zálohovať konto/ })
  await expect(dlg.getByText('Záloha nie je šifrovaná', { exact: false })).toBeVisible()
  await expect(dlg.getByText('Prázdne priečinky sa zo zálohy neobnovujú', { exact: false })).toBeVisible()
  await win.screenshot({ path: 'test-results/zaloha-start.png' })

  await dlg.getByRole('button', { name: 'Vybrať súbor a začať zálohu…' }).click()
  await expect(dlg.getByText('Úplná záloha')).toBeVisible({ timeout: 60_000 })
  await expect(dlg.getByText(target)).toBeVisible()
  await expect(dlg.getByRole('row', { name: /Doručená pošta\s+5\s+5/ })).toBeVisible()
  await expect(dlg.getByRole('row', { name: /Odoslané\s+0\s+0/ })).toBeVisible()
  await expect(dlg.getByRole('row', { name: /Projekty \/ Žltá\s+1\s+1/ })).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Otvoriť priečinok' })).toBeVisible()
  await win.screenshot({ path: 'test-results/zaloha-suhrn.png' })

  expect(existsSync(target)).toBe(true)
  expect(existsSync(`${target}.part`)).toBe(false)
  const entries = splitMboxrd(readFileSync(target)).map((e) => stripDoarBlock(e.message))
  expect(entries).toHaveLength(6)
  expect(entries.every((e) => e.hashOk)).toBe(true)

  // Hlavné okno ostalo použiteľné; dialóg sa zavrie.
  await dlg.getByRole('button', { name: 'Zavrieť' }).click()
  await expect(dlg).toBeHidden()
  await app.close()
})
