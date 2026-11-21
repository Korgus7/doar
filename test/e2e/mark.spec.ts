import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/core/store/db'
import { BlobStore } from '../../src/core/store/blobs'
import { MailStore } from '../../src/core/store/mailstore'
import { launchApp } from './helpers'

/**
 * Krúžok stavu vybavenia: konto „len v počítači“ s pripravenými správami – netreba poštový server.
 */
function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'doar-e2e-mark-'))
  const db = openDb(join(dir, 'doar.db'))
  const store = new MailStore(db)
  const blobs = new BlobStore(join(dir, 'blobs'))
  db.prepare(`INSERT INTO accounts(id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,local_only)
    VALUES (1,'stav@doar.test','imap.doar.test',993,'tls','smtp.doar.test',465,'tls','stav@doar.test',1)`).run()
  db.prepare(`INSERT INTO folders(id,account_id,path,name,special_use) VALUES (1,1,'INBOX','INBOX','inbox')`).run()
  const subjects = ['Zmluva na podpis', 'Faktúra za november', 'Pozvánka na obed']
  store.insertHeaders(
    1,
    1,
    subjects.map((subject, i) => ({
      uid: i + 1,
      size: 100,
      internalDate: `2026-11-${10 + i}T10:00:00.000Z`,
      dateHeader: null,
      messageId: `<m${i}@doar.test>`,
      inReplyTo: null,
      subject,
      fromAddr: 'jan@firma.sk',
      fromName: 'Ján Novák',
      to: [{ name: '', address: 'stav@doar.test' }],
      cc: [],
      flags: new Set(['\\Seen'])
    }))
  )
  for (const [i, subject] of subjects.entries()) {
    const raw = Buffer.from(
      `From: Ján Novák <jan@firma.sk>\r\nTo: stav@doar.test\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nMessage-ID: <m${i}@doar.test>\r\nDate: Tue, ${10 + i} Nov 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText správy\r\n`
    )
    const id = (db.prepare('SELECT id FROM messages WHERE uid = ?').get(i + 1) as { id: number }).id
    store.setBody(id, blobs.put(raw), { snippet: 'Text správy', hasAttachments: false, bodyText: 'Text správy' })
  }
  db.close()
  return dir
}

test('krúžok stavu: kliknutie mení stav, filter v hornom paneli, náhľad a ponuka', async () => {
  const dataDir = seed()
  const { app } = await launchApp({ DOAR_DATA_DIR: dataDir, LANG: 'sk_SK.UTF-8' })
  try {
    const win = await app.firstWindow()
    const list = win.getByRole('listbox')
    const row = (subject: string) => list.getByRole('option').filter({ hasText: subject })
    await expect(row('Zmluva na podpis')).toBeVisible({ timeout: 20_000 })

    // Kliknutie na krúžok: bez stavu → veľmi dôležité → dôležité → vybavené → bez stavu.
    const circle = row('Zmluva na podpis').locator('button.circle')
    await expect(circle).toHaveAttribute('title', 'Stav: Bez stavu (kliknutím zmeníte)')
    await circle.click()
    await expect(circle).toHaveAttribute('title', 'Stav: Veľmi dôležité (kliknutím zmeníte)')
    await circle.click()
    await expect(circle).toHaveAttribute('title', 'Stav: Dôležité (kliknutím zmeníte)')
    await circle.click()
    await expect(circle).toHaveAttribute('title', 'Stav: Vybavené (kliknutím zmeníte)')
    await circle.click()
    await expect(circle).toHaveAttribute('title', 'Stav: Bez stavu (kliknutím zmeníte)')
    await circle.click()
    await expect(circle).toHaveAttribute('title', 'Stav: Veľmi dôležité (kliknutím zmeníte)')

    // Pravé tlačidlo: stav priamo z ponuky.
    await row('Faktúra za november').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Vybavené' }).click()
    await expect(row('Faktúra za november').locator('button.circle')).toHaveAttribute('title', 'Stav: Vybavené (kliknutím zmeníte)')

    // Filter v hornom paneli: červené a vybavené naraz, potom len vybavené.
    const filter = win.getByRole('group', { name: 'Filter podľa stavu' })
    await filter.getByRole('button', { name: 'Zobraziť len: Veľmi dôležité' }).click()
    await expect(list.getByRole('option')).toHaveCount(1)
    await expect(row('Zmluva na podpis')).toBeVisible()
    // Upozornenie nad zoznamom, že filter je zapnutý.
    const bar = win.getByRole('status').filter({ hasText: 'Zobrazené len:' })
    await expect(bar).toContainText('Veľmi dôležité')
    await filter.getByRole('button', { name: 'Zobraziť len: Vybavené' }).click()
    await expect(list.getByRole('option')).toHaveCount(2)
    await filter.getByRole('button', { name: 'Zobraziť len: Veľmi dôležité' }).click()
    await expect(list.getByRole('option')).toHaveCount(1)
    await expect(row('Faktúra za november')).toBeVisible()
    await expect(filter.getByRole('button', { name: 'Zobraziť len: Vybavené' })).toHaveAttribute('aria-pressed', 'true')
    // Dôležité – žiadna správa.
    await filter.getByRole('button', { name: 'Zobraziť len: Vybavené' }).click()
    await filter.getByRole('button', { name: 'Zobraziť len: Dôležité' }).click()
    await expect(win.getByText('Žiadne správy s vybraným stavom.')).toBeVisible()
    await bar.getByRole('button', { name: 'Zrušiť filter' }).click()
    await expect(list.getByRole('option')).toHaveCount(3)
    await expect(bar).toHaveCount(0)
    await expect(filter.getByRole('button', { name: 'Zobraziť len: Dôležité' })).toHaveAttribute('aria-pressed', 'false')

    // Náhľad správy: krúžok vedľa hviezdičky.
    await row('Pozvánka na obed').click()
    const readerCircle = win.locator('button.mark-state')
    await expect(readerCircle).toHaveAttribute('title', 'Stav: Bez stavu (kliknutím zmeníte)')
    await readerCircle.click()
    await expect(readerCircle).toHaveAttribute('title', 'Stav: Veľmi dôležité (kliknutím zmeníte)')
    await expect(readerCircle).toHaveText('Veľmi dôležité')
    await expect(row('Pozvánka na obed').locator('button.circle')).toHaveAttribute('title', 'Stav: Veľmi dôležité (kliknutím zmeníte)')
  } finally {
    await app.close()
  }
  // Stav je uložený v databáze.
  const db = openDb(join(dataDir, 'doar.db'))
  const marks = Object.fromEntries((db.prepare('SELECT subject, mark FROM messages').all() as { subject: string; mark: number }[]).map((r) => [r.subject, r.mark]))
  db.close()
  expect(marks).toEqual({ 'Zmluva na podpis': 1, 'Faktúra za november': 3, 'Pozvánka na obed': 1 })
})
