import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { addAccountViaWizard, launchApp, testServer } from './helpers'

const srv = testServer()
test.skip(!srv, 'testovací poštový server (Dovecot) nie je k dispozícii')

const USER = 'vlado'

test.beforeAll(async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: srv!.ports.imaps, secure: true, auth: { user: `${USER}@doar.test`, pass: srv!.password }, tls: { ca: readFileSync(process.env['DOAR_TEST_CA']!) }, logger: false })
  await c.connect()
  await c.append(
    'INBOX',
    Buffer.from(
      `From: Peter Novak <peter@firma.sk>\r\nTo: ${USER}@doar.test\r\nSubject: Stretnutie v piatok\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nAhoj, stretneme sa v piatok o 10:00 v kancelárii? Peter\r\n`
    ),
    []
  )
  await c.logout()
})

const logOf = (dir: string): string => readFileSync(join(dir, 'logs', 'doar.log'), 'utf8')

/** Falošný lokálny AI server (OpenAI-kompatibilný): odpovedá podľa úlohy, zapisuje si požiadavky. */
function fakeAi() {
  const requests: { url: string; body: { messages?: { role: string; content: string }[]; model?: string } }[] = []
  const reply = (user: string): string =>
    user.includes('Summarize')
      ? 'Peter navrhuje stretnutie v piatok o 10:00.\n- Treba potvrdiť termín.'
      : user.includes('Write the body of a reply')
        ? 'Dobrý deň Peter,\n\nďakujem, piatok o 10:00 mi vyhovuje.\n\nS pozdravom'
        : user.includes('Correct spelling')
          ? 'Dobrý deň Peter, ďakujem – piatok o 10:00 mi vyhovuje. S pozdravom'
          : user.includes('Translate the text into German')
            ? 'Guten Tag Peter,'
            : 'neznáma úloha'
  const server = createServer((req: IncomingMessage, res) => {
    let raw = ''
    req.on('data', (d: Buffer) => (raw += d.toString('utf8')))
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw) as (typeof requests)[number]['body']
        requests.push({ url: req.url, body })
        const text = reply(body.messages?.find((m) => m.role === 'user')?.content ?? '')
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const part of text.match(/.{1,6}/gs) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  return { server, requests }
}

test('AI: nastavenie lokálneho modelu, zhrnutie s potvrdením, návrh odpovede a oprava textu – bez príloh, bez obsahu v logu', async () => {
  test.setTimeout(150_000)
  const { server, requests } = fakeAi()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  try {
    const { app, dataDir } = await launchApp({ LANG: 'sk_SK.UTF-8' })
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
    await win.getByRole('status').filter({ hasText: 'SQLite' }).waitFor()
    await addAccountViaWizard(win, srv!, USER)
    const list = win.getByRole('listbox', { name: 'Zoznam správ' })
    await list.getByRole('option', { name: /Stretnutie v piatok/ }).click()
    const reader = win.getByRole('region', { name: 'Čítanie správy' })
    await expect(reader.getByRole('heading', { name: 'Stretnutie v piatok' })).toBeVisible()
    // AI je predvolene vypnutá – žiadne tlačidlo.
    await expect(reader.getByRole('button', { name: /Zhrnúť/ })).toHaveCount(0)

    // Nastavenia → AI: zapnúť, lokálny model, adresa, načítať modely (zvolí sa prvý).
    await win.getByRole('button', { name: 'Nastavenia' }).first().click()
    const dlg = win.getByRole('dialog')
    await dlg.getByRole('tab', { name: 'AI' }).click()
    await dlg.getByRole('checkbox', { name: /Zapnúť AI funkcie/ }).check()
    await dlg.getByLabel('Poskytovateľ').selectOption('local')
    const url = dlg.getByLabel(/Adresa servera/)
    await url.fill('http://ai.example.com/v1')
    await url.press('Tab')
    await expect(dlg.getByRole('status').filter({ hasText: 'Nešifrované spojenie' })).toBeVisible()
    await url.fill(base)
    await url.press('Tab')
    await dlg.getByRole('button', { name: 'Načítať modely' }).click()
    await expect(dlg.getByText('Spojenie je v poriadku – modelov: 1.')).toBeVisible()
    await expect(dlg.getByLabel('Model', { exact: true })).toHaveValue('test-model')
    await expect(dlg.getByText('Kľúč nie je uložený.')).toBeVisible()
    await win.screenshot({ path: 'test-results/ai-nastavenia.png' })
    await win.keyboard.press('Escape')

    // Zhrnutie: najprv povie, čo a kam sa odošle; až potom odošle.
    await reader.getByRole('button', { name: /Zhrnúť/ }).click()
    const sum = reader.getByRole('region', { name: 'Zhrnutie' })
    await expect(sum.getByText('Odošle sa text tejto správy (bez príloh) do: Lokálny model · test-model.', { exact: false })).toBeVisible()
    expect(requests).toHaveLength(0)
    await sum.getByRole('button', { name: 'Zhrnúť' }).click()
    await expect(sum.getByText('Peter navrhuje stretnutie v piatok o 10:00.', { exact: false })).toBeVisible()
    await expect(sum.getByText('AI sa môže mýliť', { exact: false })).toBeVisible()
    await win.screenshot({ path: 'test-results/ai-zhrnutie.png' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body.model).toBe('test-model')
    const sys = requests[0]!.body.messages!.find((m) => m.role === 'system')!.content
    expect(sys).toMatch(/untrusted data/)
    const user = requests[0]!.body.messages!.find((m) => m.role === 'user')!.content
    expect(user).toContain('stretneme sa v piatok o 10:00')
    expect(user).toContain('Peter Novak <peter@firma.sk>')

    // Odpoveď: panel AI v okne správy → návrh odpovede s pokynom → vložiť pred citáciu.
    const [c] = await Promise.all([app.waitForEvent('window'), reader.getByRole('button', { name: /Odpovedať/ }).first().click()])
    await c.waitForLoadState('domcontentloaded')
    await expect(c.getByRole('button', { name: /Odoslať/ })).toBeEnabled()
    await c.getByRole('button', { name: /^AI$/ }).click()
    const panel = c.getByRole('region', { name: 'Pomoc s písaním (AI)' })
    await expect(panel.getByText('do: Lokálny model · test-model', { exact: false })).toBeVisible()
    await panel.getByLabel('Pokyn pre AI').fill('súhlas s termínom')
    await panel.getByRole('button', { name: /Navrhnúť odpoveď/ }).click()
    await expect(panel.getByText('piatok o 10:00 mi vyhovuje', { exact: false })).toBeVisible()
    const replyReq = requests[1]!.body.messages!.find((m) => m.role === 'user')!.content
    expect(replyReq).toContain('<instruction>\nsúhlas s termínom\n</instruction>')
    expect(replyReq).toContain('stretneme sa v piatok')
    await panel.getByRole('button', { name: 'Vložiť do správy' }).click()
    const editor = c.getByRole('textbox', { name: 'Text správy' })
    await expect(editor).toContainText('ďakujem, piatok o 10:00 mi vyhovuje.')
    // Návrh je nad citáciou, citácia zostala.
    const html = await editor.innerHTML()
    expect(html.indexOf('mi vyhovuje')).toBeGreaterThan(-1)
    expect(html.indexOf('mi vyhovuje')).toBeLessThan(html.indexOf('<blockquote'))
    expect(html).toContain('stretneme sa v piatok')

    // Oprava chýb bez označenia: odošle sa len vlastný text (bez citácie), výsledok ho nahradí.
    await panel.getByRole('button', { name: 'Opraviť chyby' }).click()
    await expect(panel.getByText('ďakujem – piatok', { exact: false })).toBeVisible()
    const fixReq = requests[2]!.body.messages!.find((m) => m.role === 'user')!.content
    expect(fixReq).toContain('piatok o 10:00 mi vyhovuje')
    expect(fixReq).not.toContain('stretneme sa')
    await panel.getByRole('button', { name: 'Nahradiť môj text' }).click()
    await expect(editor).toContainText('Dobrý deň Peter, ďakujem – piatok o 10:00 mi vyhovuje. S pozdravom')
    await expect(editor).not.toContainText('ďakujem, piatok')
    await expect(editor).toContainText('stretneme sa v piatok')
    await c.screenshot({ path: 'test-results/ai-odpoved.png' })
    // AI nič neodoslala – okno správy je stále otvorené a správa neodišla.
    expect(c.isClosed()).toBe(false)
    expect(requests).toHaveLength(3)
    expect(logOf(dataDir)).not.toContain('stretneme sa')

    await c.close()

    // Čistý text (bez formátovania): návrh odpovede nad citáciu, preklad označeného textu.
    await win.evaluate(() => (globalThis as unknown as { doar: { invoke(ch: string, d: unknown): Promise<unknown> } }).doar.invoke('settings.set', { composeHtml: false }))
    const [p] = await Promise.all([app.waitForEvent('window'), reader.getByRole('button', { name: /Odpovedať/ }).first().click()])
    await p.waitForLoadState('domcontentloaded')
    await expect(p.getByRole('button', { name: /Odoslať/ })).toBeEnabled()
    const area = p.getByRole('textbox', { name: 'Text správy' })
    await expect(area).toHaveValue(/> Ahoj, stretneme sa/)
    await p.getByRole('button', { name: /^AI$/ }).click()
    const panel2 = p.getByRole('region', { name: 'Pomoc s písaním (AI)' })
    await panel2.getByRole('button', { name: /Navrhnúť odpoveď/ }).click()
    await panel2.getByRole('button', { name: 'Vložiť do správy' }).click()
    await expect(area).toHaveValue(/^Dobrý deň Peter,\n\nďakujem, piatok o 10:00 mi vyhovuje\.\n\nS pozdravom\n\n.*napísal\(a\):\n> Ahoj, stretneme sa/s)
    await area.evaluate((el, n) => (el as unknown as { setSelectionRange(a: number, b: number): void }).setSelectionRange(0, n), 'Dobrý deň Peter,'.length)
    await panel2.getByLabel('Jazyk prekladu').selectOption('de')
    await panel2.getByRole('button', { name: 'Preložiť do' }).click()
    await expect(panel2.getByText('Odošle sa označený text', { exact: false })).toBeVisible()
    await panel2.getByRole('button', { name: 'Nahradiť označený text' }).click()
    await expect(area).toHaveValue(/^Guten Tag Peter,\n\nďakujem, piatok o 10:00 mi vyhovuje\./)
    const trReq = requests.at(-1)!.body.messages!.find((m) => m.role === 'user')!.content
    expect(trReq).toContain('<text>\nDobrý deň Peter,\n</text>')
    // Ctrl+Z vráti preklad späť.
    await area.press('Control+z')
    await expect(area).toHaveValue(/^Dobrý deň Peter,\n\nďakujem/)
    await p.close()

    // Log: nikdy obsah pošty ani výstup AI.
    const logText = logOf(dataDir)
    expect(logText).toContain('AI hotovo')
    expect(logText).not.toContain('stretneme sa')
    expect(logText).not.toContain('mi vyhovuje')
    expect(logText).not.toContain('Guten Tag')
    await app.close()
  } finally {
    server.close()
  }
})
