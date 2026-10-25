import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const imap = (user: string) =>
  new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${user}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })

async function sources(user: string, path = 'INBOX'): Promise<string[]> {
  const c = imap(user)
  await c.connect()
  const out: string[] = []
  const lock = await c.getMailboxLock(path)
  try {
    if (c.mailbox && c.mailbox.exists) for await (const m of c.fetch('1:*', { source: true })) out.push(m.source!.toString())
  } finally {
    lock.release()
    await c.logout()
  }
  return out
}

test.beforeAll(async () => {
  const c = imap('filip')
  await c.connect()
  await c.append(
    'INBOX',
    Buffer.from('From: Gita <gita@doar.test>\r\nTo: filip@doar.test\r\nSubject: Obed v piatok?\r\nMessage-ID: <obed-1@doar.test>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nIdeme na obed v piatok o 12:00?\r\n'),
    []
  )
  await c.logout()
})

test('písanie: nová správa, odpoveď s citáciou, nejasný výsledok, zatvorenie rozpísanej správy', async () => {
  test.setTimeout(180_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, 'filip')
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  await expect(list.getByRole('option', { name: /Obed v piatok/ })).toBeVisible({ timeout: 30_000 })

  const openCompose = async (click: () => Promise<void>): Promise<Page> => {
    const [w] = await Promise.all([app.waitForEvent('window'), click()])
    await w.waitForLoadState('domcontentloaded')
    await expect(w.getByRole('button', { name: /Odoslať/ })).toBeEnabled()
    return w
  }

  // 1. Nová správa
  const c1 = await openCompose(() => win.getByRole('button', { name: /Nová správa/ }).click())
  await expect(c1.getByRole('combobox', { name: /^Od/ })).toHaveValue(/\d+/)
  await c1.getByLabel('Komu').fill('Gita <gita@doar.test>')
  await c1.getByLabel('Predmet').fill('Pozdrav z Doaru')
  await c1.getByLabel('Text správy').fill('Ahoj Gita,\npíšem z nového klienta Doar.\n\nFilip')
  await c1.screenshot({ path: 'test-results/nova-sprava.png' })
  await Promise.all([c1.waitForEvent('close'), c1.keyboard.press('Control+Enter')])
  await expect.poll(async () => (await sources('gita')).some((s) => s.includes('Subject: Pozdrav z Doaru')), { timeout: 20_000 }).toBe(true)
  // Kópia v Odoslaných aj v Doare.
  await win.getByRole('navigation', { name: 'Priečinky' }).getByRole('button', { name: /^Odoslané/ }).click()
  await expect(list.getByRole('option', { name: /Pozdrav z Doaru/ })).toBeVisible({ timeout: 20_000 })
  await expect(list.getByRole('option', { name: /Gita/ })).toBeVisible() // v Odoslaných sa ukazuje adresát

  // 2. Odpoveď
  await win.getByRole('navigation', { name: 'Priečinky' }).getByRole('button', { name: /^Doručená pošta/ }).click()
  await list.getByRole('option', { name: /Obed v piatok/ }).click()
  const c2 = await openCompose(() => win.getByRole('button', { name: /^↩ Odpovedať$/ }).click())
  await expect(c2.getByLabel('Komu')).toHaveValue('Gita <gita@doar.test>')
  await expect(c2.getByLabel('Predmet')).toHaveValue('Re: Obed v piatok?')
  // Formátovaná odpoveď: prázdny odsek na písanie, hlavička citácie, citácia ako blockquote.
  const editor = c2.getByRole('textbox', { name: 'Text správy' })
  expect(await editor.innerHTML()).toMatch(/^<p dir="auto"><br[^>]*><\/p><p dir="auto">Dňa \S.+ Gita &lt;gita@doar\.test&gt; napísal\(a\):<\/p><blockquote><p dir="auto">Ideme na obed v piatok o 12:00\?<\/p><\/blockquote>(<p dir="auto"><br[^>]*><\/p>)?$/)
  await expect(editor).toBeFocused() // kurzor je hneď pripravený na začiatku
  await c2.keyboard.type('Áno, ')
  await c2.keyboard.press('Control+b')
  await c2.keyboard.type('budem')
  await c2.keyboard.press('Control+b')
  await c2.keyboard.type(' tam.')
  await c2.screenshot({ path: 'test-results/odpoved.png' })
  await Promise.all([c2.waitForEvent('close'), c2.getByRole('button', { name: /Odoslať/ }).click()])
  await expect.poll(async () => (await sources('gita')).some((s) => s.includes('Subject: Re: Obed v piatok?')), { timeout: 20_000 }).toBe(true)
  const replyRaw = (await sources('gita')).find((s) => s.includes('Subject: Re: Obed v piatok?'))!
  const reply = await simpleParser(replyRaw)
  expect(reply.inReplyTo).toBe('<obed-1@doar.test>')
  expect(reply.text).toMatch(/^Áno, budem tam\.\n\nDňa .+ Gita <gita@doar\.test> napísal\(a\):\n\n> Ideme na obed v piatok o 12:00\?/)
  expect(reply.html).toContain('Áno, <strong>budem</strong> tam.')
  expect(reply.html).toMatch(/<blockquote style="[^"]+"><p[^>]*>Ideme na obed v piatok o 12:00\?<\/p><\/blockquote>/)

  // 3. Nejasný výsledok → upozornenie, bezpečná voľba „Neodosielať“
  const c3 = await openCompose(() => win.getByRole('button', { name: /Nová správa/ }).click())
  await c3.getByLabel('Komu').fill('prerusenie@doar.test')
  await c3.getByLabel('Predmet').fill('Test prerušenia')
  await c3.getByLabel('Text správy').fill('x')
  await Promise.all([c3.waitForEvent('close'), c3.getByRole('button', { name: /Odoslať/ }).click()])
  const banner = win.getByRole('region', { name: 'Odosielanie' })
  await expect(banner.getByText('Nie je isté, či sa správa „Test prerušenia“ odoslala', { exact: false })).toBeVisible({ timeout: 30_000 })
  await win.screenshot({ path: 'test-results/nejasny-vysledok.png' })
  await banner.getByRole('button', { name: 'Neodosielať' }).click()
  await expect(banner).toBeHidden()

  // 4. Zatvorenie rozpísanej správy: bez otázky – uloží sa ako koncept (podrobne v drafts.spec.ts).
  const c4 = await openCompose(() => win.getByRole('button', { name: /Nová správa/ }).click())
  await c4.getByLabel('Text správy').fill('Rozpísané…')
  await expect(c4.getByRole('status')).toContainText('Koncept uložený', { timeout: 10_000 })
  await Promise.all([c4.waitForEvent('close'), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Nová správa')?.close())])

  await app.close()
})
