import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, openSettingsTab, testServer } from './helpers'

// Presun medzi kontami ťahaním: správy na priečinok iného konta, priečinok na hlavičku iného konta, Ctrl = kópia.

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'quido'
const USER2 = 'rita'

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${user}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })

async function onServer<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = imap(user)
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.logout().catch(() => {})
  }
}

const subjects = (user: string, path: string) =>
  onServer(user, async (c) => {
    try {
      const lock = await c.getMailboxLock(path)
      try {
        if (!c.mailbox || !c.mailbox.exists) return []
        const out: string[] = []
        for await (const m of c.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '')
        return out.sort()
      } finally {
        lock.release()
      }
    } catch {
      return []
    }
  })
const folders = (user: string) => onServer(user, async (c) => (await c.list()).map((f) => f.path))

const msg = (to: string, s: string) => Buffer.from(`From: Eva <eva@firma.sk>\r\nTo: ${to}@doar.test\r\nSubject: ${s}\r\nMessage-ID: <${s.replace(/\W/g, '')}.${Date.now()}@firma.sk>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText ${s}\r\n`)

test.beforeAll(async () => {
  await onServer(USER, async (c) => {
    for (const s of ['Presuň ma', 'Skopíruj ma']) await c.append('INBOX', msg(USER, s), ['\\Seen'])
    await c.mailboxCreate('Staré')
    await c.append('Staré', msg(USER, 'V starom'), ['\\Seen'])
  })
})

/** Ťahanie po krokoch (systémové ťahanie sa pri jednom skoku občas nezačne). */
async function drag(win: Page, from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']>, ctrl = false): Promise<void> {
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await win.mouse.down()
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 8, { steps: 4 })
  if (ctrl) await win.keyboard.down('Control')
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
  await win.mouse.up()
  if (ctrl) await win.keyboard.up('Control')
}

test('presun medzi kontami: správy, kópia s Ctrl, priečinok na hlavičku iného konta', async () => {
  test.setTimeout(180_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, USER)
  await (await openSettingsTab(win, 'Kontá')).getByRole('button', { name: '+ Pridať konto…' }).click()
  await addAccountViaWizard(win, srv!, USER2, { openWizard: false })

  const pane = win.getByRole('navigation', { name: 'Priečinky' })
  const account = (user: string) => pane.locator('section.account').filter({ has: win.locator('.acc-name', { hasText: `${user}@doar.test` }) })
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  const row = (s: string) => list.getByRole('option').filter({ hasText: s })
  const toast = win.locator('.toast')

  // Správu na Doručenú poštu druhého konta: presun (v prvom konte ide do Koša).
  await account(USER).getByRole('button', { name: /^Doručená pošta/ }).click()
  await expect(row('Presuň ma')).toBeVisible({ timeout: 30_000 })
  const target = account(USER2).getByRole('button', { name: /^Doručená pošta/ })
  await expect(async () => {
    if (!(await subjects(USER2, 'INBOX')).includes('Presuň ma')) await drag(win, row('Presuň ma'), target)
    expect(await subjects(USER2, 'INBOX')).toContain('Presuň ma')
  }).toPass({ timeout: 30_000 })
  await expect(toast).toContainText(`Presunuté do konta ${USER2}@doar.test: 1.`)
  await expect.poll(() => subjects(USER, 'Trash'), { timeout: 30_000 }).toContain('Presuň ma')
  await expect(row('Presuň ma')).toHaveCount(0)

  // S Ctrl = kópia: v prvom konte ostane.
  await expect(async () => {
    if (!(await subjects(USER2, 'INBOX')).includes('Skopíruj ma')) await drag(win, row('Skopíruj ma'), target, true)
    expect(await subjects(USER2, 'INBOX')).toContain('Skopíruj ma')
  }).toPass({ timeout: 30_000 })
  await expect(toast).toContainText(`Skopírované do konta ${USER2}@doar.test: 1.`)
  expect(await subjects(USER, 'INBOX')).toContain('Skopíruj ma')
  await expect(row('Skopíruj ma')).toBeVisible()

  // Priečinok na hlavičku druhého konta (potvrdenie) → vznikne tam so správou, v prvom konte zmizne.
  win.on('dialog', (d) => void d.accept())
  await expect(async () => {
    if (!(await folders(USER2)).includes('Staré')) await drag(win, account(USER).getByRole('button', { name: /^Staré/ }), account(USER2).locator('h2'))
    expect(await folders(USER2)).toContain('Staré')
  }).toPass({ timeout: 30_000 })
  await expect.poll(() => subjects(USER2, 'Staré'), { timeout: 30_000 }).toEqual(['V starom'])
  await expect.poll(async () => (await folders(USER)).includes('Staré'), { timeout: 30_000 }).toBe(false)
  await expect(account(USER2).getByRole('button', { name: /^Staré/ })).toBeVisible({ timeout: 30_000 })
  await expect(account(USER).getByRole('button', { name: /^Staré/ })).toHaveCount(0)
  await app.close()
})
