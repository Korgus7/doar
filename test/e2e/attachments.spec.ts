import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'nina'
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5000, 7)])
const b64 = (b: Buffer) => b.toString('base64').replace(/.{76}/g, '$&\r\n')

const imap = () =>
  new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${USER}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })

async function find(subject: string): Promise<Buffer | null> {
  const c = imap()
  await c.connect()
  try {
    const lock = await c.getMailboxLock('INBOX')
    try {
      for await (const m of c.fetch('1:*', { envelope: true, source: true })) if (m.envelope?.subject === subject) return m.source ?? null
      return null
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
}

test.beforeAll(async () => {
  const c = imap()
  await c.connect()
  await c.append(
    'INBOX',
    Buffer.from(
      [
        'From: Účtovníčka <uctovnicka@firma.sk>',
        `To: ${USER}@doar.test`,
        'Subject: Faktúra za október',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        'Dobrý deň, posielam faktúru.',
        '--b',
        'Content-Type: application/pdf; name="faktura.pdf"',
        'Content-Disposition: attachment; filename="faktura.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        b64(PDF),
        '--b',
        'Content-Type: application/octet-stream; name="setup.exe"',
        'Content-Disposition: attachment; filename="setup.exe"',
        'Content-Transfer-Encoding: base64',
        '',
        b64(Buffer.from('MZ')),
        '--b--',
        ''
      ].join('\r\n')
    ),
    []
  )
  await c.logout()
})

test('prílohy: uložiť, otvoriť (program nie), preposlať s prílohami a priložiť súbor', async () => {
  test.setTimeout(180_000)
  const dir = mkdtempSync(join(tmpdir(), 'doar-e2e-att-'))
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 760 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, USER)

  // Natívne dialógy a otvorenie súboru nahradíme (v teste ich nemá kto obslúžiť).
  const saved = join(dir, 'ulozena-faktura.pdf')
  const extra = join(dir, 'Zmluva o dielo.docx')
  writeFileSync(extra, 'obsah zmluvy')
  await app.evaluate(({ dialog, shell }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p.saved })) as typeof dialog.showSaveDialog
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p.extra] })) as typeof dialog.showOpenDialog
    shell.openPath = async (path: string) => {
      ;(globalThis as { opened?: string }).opened = path
      return ''
    }
  }, { saved, extra })

  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  await list.getByRole('option', { name: /Faktúra za október/ }).click()
  const reader = win.getByRole('region', { name: 'Čítanie správy' })
  await expect(reader.getByText('Prílohy (2)')).toBeVisible({ timeout: 20_000 })
  await win.screenshot({ path: 'test-results/prilohy-citanie.png' })

  // Uložiť ako… (PDF má na klik náhľad – ponuka je na pravom tlačidle).
  await reader.getByRole('button', { name: /faktura\.pdf/ }).click({ button: 'right' })
  const menu = win.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Náhľad' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Uložiť ako…' }).click()
  await expect(win.getByRole('status').filter({ hasText: 'Príloha je uložená' })).toBeVisible()
  expect(readFileSync(saved).equals(PDF)).toBe(true)

  // Otvoriť: dočasná kópia v dátovom priečinku Doaru.
  await reader.getByRole('button', { name: /faktura\.pdf/ }).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Otvoriť' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string }).opened ?? '')).toMatch(/otvorene-prilohy[\\/].+[\\/]faktura\.pdf$/)
  const opened = await app.evaluate(() => (globalThis as { opened?: string }).opened!)
  expect(existsSync(opened) && readFileSync(opened).equals(PDF)).toBe(true)

  // Program sa otvoriť nedá – len uložiť.
  await reader.getByRole('button', { name: /setup\.exe/ }).click()
  await expect(menu.getByRole('menuitem', { name: /Otvoriť – nedá sa/ })).toBeDisabled()
  await win.screenshot({ path: 'test-results/prilohy-program.png' })
  await win.keyboard.press('Escape')

  // Preposlať: prílohy pôvodnej správy, jednu odstrániť, jednu pridať z disku.
  const [cw] = await Promise.all([app.waitForEvent('window'), reader.getByRole('button', { name: /Preposlať/ }).click()])
  const c: Page = cw
  await c.waitForLoadState('domcontentloaded')
  await expect(c.getByLabel('Predmet')).toHaveValue('Fwd: Faktúra za október')
  const editor = c.getByRole('textbox', { name: 'Text správy' })
  await expect(editor).toContainText('Preposlaná správa')
  await expect(editor).toContainText('Od: Účtovníčka <uctovnicka@firma.sk>')
  await expect(editor).toContainText('Dobrý deň, posielam faktúru.')
  const atts = c.getByRole('region', { name: 'Prílohy' })
  await expect(atts.getByText('faktura.pdf')).toBeVisible()
  await expect(atts.getByText('setup.exe')).toBeVisible()
  await atts.getByRole('button', { name: 'Odstrániť prílohu setup.exe' }).click()
  await c.getByRole('button', { name: /Priložiť súbor/ }).click()
  await expect(atts.getByText('Zmluva o dielo.docx')).toBeVisible()
  await c.getByLabel('Komu').fill(`${USER}@doar.test`)
  await c.screenshot({ path: 'test-results/prilohy-preposlat.png' })
  await Promise.all([c.waitForEvent('close'), c.getByRole('button', { name: /Odoslať/ }).click()])

  let raw: Buffer | null = null
  await expect.poll(async () => (raw = await find('Fwd: Faktúra za október')) !== null, { timeout: 30_000 }).toBe(true)
  const p = await simpleParser(raw!)
  expect(p.attachments.map((a) => a.filename)).toEqual(['faktura.pdf', 'Zmluva o dielo.docx'])
  expect(p.attachments[0]!.content.equals(PDF)).toBe(true)
  expect(p.attachments[1]!.content.toString()).toBe('obsah zmluvy')
  expect(p.text).toContain('Preposlaná správa')

  await app.close()
})
