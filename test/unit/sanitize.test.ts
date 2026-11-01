import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import MailComposer from 'nodemailer/lib/mail-composer'
import { renderMessage } from '../../src/core/mail/parse'
import { sanitizeEmailHtml, textToHtml } from '../../src/core/mail/sanitize'

const clean = (html: string, remote: Map<string, string> | null = null) => sanitizeEmailHtml(html, { cid: new Map([['logo@x', 'data:image/png;base64,AA']]), remote })

describe('sanitizácia HTML pošty', () => {
  it.each([
    ['<script>alert(1)</script>ahoj', /<script|alert/],
    ['<img src=x onerror="alert(1)">', /onerror/],
    ['<a href="javascript:alert(1)">x</a>', /javascript:/],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', /data:text/],
    ['<iframe src="https://evil.sk"></iframe>', /iframe|evil/],
    ['<object data="x.swf"></object><embed src="x">', /object|embed/],
    ['<form action="https://evil.sk"><input name="heslo"></form>', /form|input/],
    ['<meta http-equiv="refresh" content="0;url=https://evil.sk">', /meta|refresh/],
    ['<base href="https://evil.sk/">', /base/],
    ['<link rel="stylesheet" href="https://evil.sk/a.css">', /link|evil/],
    ['<svg><script>alert(1)</script></svg>', /svg|script/],
    ['<div style="x" onmouseover="alert(1)">a</div>', /onmouseover/],
    ['<img src="//tracker.sk/p.gif">', /tracker/]
  ])('odstráni nebezpečný obsah %#', (input, bad) => {
    expect(clean(input).html).not.toMatch(bad)
  })

  it('zachová bežné formátovanie, tabuľky, štýly a bezpečné odkazy', () => {
    const r = clean('<style>.a{color:red}</style><table><tr><td class="a" style="color:blue">Text</td></tr></table><a href="https://shop.sk" target="_blank">odkaz</a><a href="mailto:a@b.sk">mail</a>')
    expect(r.html).toContain('<style>.a{color:red}</style>')
    expect(r.html).toContain('<td class="a" style="color:blue">Text</td>')
    expect(r.html).toContain('<a href="https://shop.sk">odkaz</a>')
    expect(r.html).toContain('href="mailto:a@b.sk"')
  })

  it('vzdialené obrázky blokuje a počíta, po povolení vloží stiahnuté data: URI', () => {
    const html = '<img src="https://t.sk/a.png"><img src="http://t.sk/b.png"><img src="cid:logo@x">'
    const blocked = clean(html)
    expect(blocked.blocked).toBe(2)
    expect(blocked.remoteUrls).toEqual(['https://t.sk/a.png', 'http://t.sk/b.png'])
    expect(blocked.html).not.toContain('t.sk')
    expect(blocked.html).toContain('data:image/png;base64,AA')

    const shown = clean(html, new Map([['https://t.sk/a.png', 'data:image/png;base64,BB']]))
    expect(shown.html).toContain('data:image/png;base64,BB')
    expect(shown.html).not.toContain('t.sk')
    expect(shown.blocked).toBe(1) // b.png sa nepodarilo stiahnuť – ostáva blokovaný
  })

  it('čistý text: escapovanie a klikateľné odkazy', () => {
    const h = textToHtml('Ahoj <b>svet</b> & pozri https://shop.sk/akcia?x=1&y=2.')
    expect(h).toContain('&lt;b&gt;svet&lt;/b&gt; &amp;')
    expect(h).toContain('<a href="https://shop.sk/akcia?x=1&amp;y=2">')
    expect(h).not.toContain('<b>')
  })
})

import { htmlToPlain, indexInfo } from '../../src/core/mail/parse'

describe('text z HTML pre náhľad a vyhľadávanie', () => {
  it('bez štýlov, adries obrázkov a značiek; entity dekódované', () => {
    const t = htmlToPlain('<html><head><style>p{color:red}</style></head><body><h1>Jesenná akcia</h1><p>Zľavy&nbsp;až 30&nbsp;% &amp; viac</p><img src="https://t.sk/p.gif"><a href="https://shop.sk">Pozrieť</a> &#352;&#x10D;</body></html>')
    expect(t).toBe('Jesenná akcia\nZľavy až 30 % & viac\nPozrieť Šč')
  })
  it('náhľad HTML správy neobsahuje adresy obrázkov ani veľké písmená z nadpisov', async () => {
    const raw = Buffer.from('From: a@b.sk\r\nSubject: x\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h1>Jesenná akcia</h1><img src="https://tracker.sk/p.gif"><p>Zľavy</p>\r\n')
    const info = await indexInfo(raw)
    expect(info.snippet).toBe('Jesenná akcia Zľavy')
  })
})

describe('obrázky vložené do správy (Gmail, iPhone)', () => {
  const build = async (mail: ConstructorParameters<typeof MailComposer>[0]): Promise<Buffer> => new MailComposer(mail).compile().build()
  it('Gmail: veľká fotka cez cid sa zobrazí v texte a nie je príloha; HEIC ostane prílohou', async () => {
    const photo = randomBytes(5 * 1024 * 1024)
    const raw = await build({
      from: 'a@gmail.com', to: 'b@x.sk', subject: 'Foto',
      html: '<div>Pozri <img src="cid:ii_abc"> a <img src="cid:heic1"></div>',
      attachments: [
        { filename: 'IMG_1.jpg', content: photo, cid: 'ii_abc', contentType: 'image/jpeg' },
        { filename: 'IMG_2.heic', content: Buffer.from('heic'), cid: 'heic1', contentType: 'image/heic' }
      ]
    })
    const r = await renderMessage(raw, null)
    expect(r.html).toContain(`src="data:image/jpeg;base64,${photo.subarray(0, 30).toString('base64').slice(0, 20)}`)
    expect(r.attachments.map((a) => a.filename)).toEqual(['IMG_2.heic'])
  })
  it('iPhone: text a fotka ako vložená časť bez odkazu z HTML → fotka na konci správy, dá sa aj uložiť', async () => {
    const photo = randomBytes(1000)
    const raw = await build({
      from: 'a@icloud.com', to: 'b@x.sk', subject: 'Z iPhonu', text: 'Posielam fotku',
      attachments: [{ filename: 'IMG_3.jpeg', content: photo, contentType: 'image/jpeg', contentDisposition: 'inline' }]
    })
    const r = await renderMessage(raw, null)
    expect(r.html).toContain('Posielam fotku')
    expect(r.html).toContain(`<div class="doar-inline-img"><img src="data:image/jpeg;base64,${photo.toString('base64')}" alt=""></div>`)
    expect(r.attachments.map((a) => a.filename)).toEqual(['IMG_3.jpeg'])
  })
})
