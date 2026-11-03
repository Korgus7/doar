import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { clearRemoteCache, fetchRemoteImages } from '../../src/core/mail/remote'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1f1a7e40000000049454e44ae426082', 'hex')
let server: Server
let base = ''
let hits = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++
    const delay = req.url?.startsWith('/slow') ? 600 : 0
    setTimeout(() => {
      if (req.url?.startsWith('/text')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end('<p>nie obrázok</p>')
      }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    }, delay)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
beforeEach(() => {
  clearRemoteCache()
  hits = 0
})

describe('vzdialené obrázky', () => {
  it('pomalý obrázok nezdrží zobrazenie – dotiahne sa neskôr a ohlási sa', async () => {
    let late = 0
    const t0 = Date.now()
    const map = await fetchRemoteImages([`${base}/fast.png`, `${base}/slow.png`, `${base}/text`], { waitMs: 200, onLate: () => late++ })
    expect(Date.now() - t0).toBeLessThan(500)
    expect([...map.keys()]).toEqual([`${base}/fast.png`])
    expect(map.get(`${base}/fast.png`)).toMatch(/^data:image\/png;base64,/)
    await new Promise((r) => setTimeout(r, 900))
    expect(late).toBe(1)
    // Druhé otvorenie: všetko z pamäte, bez ďalšieho sťahovania.
    const before = hits
    const again = await fetchRemoteImages([`${base}/fast.png`, `${base}/slow.png`, `${base}/text`], { waitMs: 200 })
    expect(again.size).toBe(2)
    expect(hits).toBe(before)
  })

  it('všetko načas: bez dodatočného ohlásenia', async () => {
    let late = 0
    const map = await fetchRemoteImages([`${base}/a.png`, `${base}/a.png`, 'ftp://x/y.png'], { waitMs: 1000, onLate: () => late++ })
    expect(map.size).toBe(1)
    expect(hits).toBe(1)
    await new Promise((r) => setTimeout(r, 50))
    expect(late).toBe(0)
  })
})
