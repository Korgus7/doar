import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'karol'

function imap(): ImapFlow {
  return new ImapFlow({
    host: '127.0.0.1',
    port: srv!.ports.imaps,
    secure: true,
    auth: { user: `${USER}@doar.test`, pass: srv!.password },
    tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) },
    logger: false
  })
}

const plain = (subject: string) =>
  Buffer.from(`From: Ján Novák <jan@firma.sk>\r\nTo: ${USER}@doar.test\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText\r\n`)

/** Predmety správ v priečinku na serveri (overenie iným klientom). */
async function onServer(path: string): Promise<string[]> {
  const c = imap()
  await c.connect()
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
  } finally {
    await c.logout().catch(() => {})
  }
}

test.beforeAll(async () => {
  const c = imap()
  await c.connect()
  for (const s of ['Prvá', 'Druhá', 'Tretia', 'Štvrtá', 'Piata']) await c.append('INBOX', plain(s), ['\\Seen'])
  await c.logout()
})

test('akcie: Kôš a Vrátiť späť, presun do nového priečinka, ťahanie, výber viacerých, Archív, natrvalo', async () => {
  test.setTimeout(180_000)
  const { app } = await launchApp({ LANG: 'sk_SK.UTF-8' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 760 }).catch(() => {})
  await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
  await addAccountViaWizard(win, srv!, USER)

  const folders = win.getByRole('navigation', { name: 'Priečinky' })
  const list = win.getByRole('listbox', { name: 'Zoznam správ' })
  const row = (s: string) => list.getByRole('option', { name: new RegExp(s) })
  const toast = win.getByRole('status').filter({ hasText: /presunut|odstránen|Vrátené|Priečinok/ })
  await folders.getByRole('button', { name: /^Doručená pošta/ }).click()
  await expect(list.getByRole('option')).toHaveCount(5, { timeout: 30_000 })

  // Del → hneď zmizne, „Vrátiť späť“ ju vráti a server sa nezmení.
  await row('Prvá').click()
  await win.keyboard.press('Delete')
  await expect(row('Prvá')).toHaveCount(0)
  await expect(toast).toContainText('presunutá do priečinka „Kôš“')
  await win.screenshot({ path: 'test-results/akcie-kos-vratit.png' })
  await toast.getByRole('button', { name: 'Vrátiť späť' }).click()
  await expect(row('Prvá')).toBeVisible()
  await expect(toast).toContainText('Vrátené späť')

  // Del znova a nechať uplynúť čas → na serveri v Koši.
  await row('Prvá').click()
  await win.keyboard.press('Delete')
  await expect(row('Prvá')).toHaveCount(0)
  // V Koši je hneď (so značkou „čaká na server“), nečaká sa na uplynutie času na „Vrátiť späť“.
  await folders.getByRole('button', { name: /^Kôš/ }).click()
  await expect(row('Prvá')).toBeVisible({ timeout: 2000 })
  await expect(row('Prvá').getByTitle('Zmena čaká na uloženie na server')).toBeVisible()
  await folders.getByRole('button', { name: /^Doručená pošta/ }).click()
  await expect(row('Prvá')).toHaveCount(0)
  await row('Druhá').click()
  // Po presune je vybraná ďalšia správa.
  await expect(list.getByRole('option', { selected: true })).toHaveCount(1)
  await expect.poll(() => onServer('Trash'), { timeout: 30_000 }).toContain('Prvá')

  // Kontextová ponuka → Presunúť do priečinka… → nový priečinok priamo z dialógu.
  await row('Druhá').click({ button: 'right' })
  const menu = win.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: /Odstrániť natrvalo/ })).toBeVisible()
  await win.screenshot({ path: 'test-results/akcie-ponuka.png' })
  await menu.getByRole('menuitem', { name: /Presunúť do priečinka/ }).click()
  const moveDlg = win.getByRole('dialog', { name: 'Presunúť do priečinka' })
  await moveDlg.getByRole('button', { name: /Nový priečinok/ }).click()
  const newDlg = win.getByRole('dialog', { name: 'Nový priečinok' })
  await newDlg.getByLabel('Názov priečinka').fill('Projekty Ľubica')
  await newDlg.getByRole('button', { name: 'Vytvoriť' }).click()
  await expect(newDlg).toHaveCount(0)
  await expect(moveDlg.getByRole('option', { name: 'Projekty Ľubica', selected: true })).toBeVisible()
  await moveDlg.getByRole('button', { name: 'Presunúť', exact: true }).click()
  await expect(row('Druhá')).toHaveCount(0)
  await expect(folders.getByRole('button', { name: /^Projekty Ľubica/ })).toBeVisible()
  await expect.poll(() => onServer('Projekty Ľubica'), { timeout: 30_000 }).toContain('Druhá')

  // Ťahanie myšou na priečinok.
  await row('Tretia').dragTo(folders.getByRole('button', { name: /^Projekty Ľubica/ }))
  await expect(row('Tretia')).toHaveCount(0)
  await expect.poll(() => onServer('Projekty Ľubica'), { timeout: 30_000 }).toContain('Tretia')

  // Výber viacerých (Ctrl + klik) a Archív klávesom E.
  await row('Štvrtá').click()
  await row('Piata').click({ modifiers: ['Control'] })
  const reader = win.getByRole('region', { name: 'Čítanie správy' })
  await expect(reader.getByText('Vybrané správy: 2')).toBeVisible()
  await win.keyboard.press('e')
  await expect(list.getByRole('option')).toHaveCount(0)
  await expect(toast).toContainText('Správy (2) sú presunuté do priečinka „Archív“')
  await expect.poll(() => onServer('Archive'), { timeout: 30_000 }).toEqual(['Piata', 'Štvrtá'])

  // V Koši: Del = natrvalo, s potvrdením.
  await folders.getByRole('button', { name: /^Kôš/ }).click()
  await expect(row('Prvá')).toBeVisible({ timeout: 15_000 })
  win.once('dialog', (d) => void d.accept())
  await row('Prvá').click()
  await win.keyboard.press('Delete')
  await expect(row('Prvá')).toHaveCount(0)
  await expect.poll(() => onServer('Trash'), { timeout: 30_000 }).toEqual([])

  await win.screenshot({ path: 'test-results/akcie-koniec.png' })
  await app.close()
})
