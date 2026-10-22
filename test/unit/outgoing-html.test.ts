import { describe, it, expect } from 'vitest'
import { htmlToText, outgoingHtml, sanitizeComposeHtml } from '../../src/core/mail/outgoing-html'

describe('formátovaná správa → text a bezpečné HTML', () => {
  it('textová podoba zachová štruktúru', () => {
    const html =
      '<p>Dobrý deň,</p><p>posielam <strong>ponuku</strong> a <a href="https://firma.sk/cennik">cenník</a>.<br>Druhý riadok</p>' +
      '<ul><li><p>prvá položka</p></li><li><p>druhá</p></li></ul><ol><li><p>jeden</p></li><li><p>dva</p></li></ol>' +
      '<p>-- <br>Ján</p><blockquote><p>Pôvodná správa</p><p>riadok 2 &amp; &lt;viac&gt;</p></blockquote>'
    expect(htmlToText(html)).toBe(
      [
        'Dobrý deň,',
        '',
        'posielam ponuku a cenník <https://firma.sk/cennik>.',
        'Druhý riadok',
        '',
        '- prvá položka',
        '- druhá',
        '',
        '1. jeden',
        '2. dva',
        '',
        '-- ',
        'Ján',
        '',
        '> Pôvodná správa',
        '>',
        '> riadok 2 & <viac>'
      ].join('\n')
    )
  })

  it('oddeľovač podpisu „-- “ aj keď editor zahodil medzeru', () => {
    expect(htmlToText('<p>Ahoj</p><p>--<br>Ján</p>')).toBe('Ahoj\n\n-- \nJán')
  })

  it('odkaz, ktorého text je adresa, sa nezdvojí; mailto bez predpony', () => {
    expect(htmlToText('<p><a href="https://x.sk">https://x.sk</a> a <a href="mailto:eva@x.sk">Eva</a></p>')).toBe('https://x.sk a Eva <eva@x.sk>')
  })

  it('nebezpečné veci z rozhrania sa neodošlú', () => {
    const bad = '<p onclick="x()">Ahoj<script>alert(1)</script><img src="https://sledovanie.sk/p.gif"><a href="javascript:alert(1)">klik</a><iframe src="x"></iframe><style>p{}</style></p>'
    const clean = sanitizeComposeHtml(bad)
    expect(clean).toBe('<p>Ahoj<a>klik</a></p>')
    const out = outgoingHtml(bad)
    expect(out).not.toMatch(/script|onclick|img|iframe|javascript|<style/i)
    expect(out).toContain('<p style="margin:0 0 0.6em">Ahoj')
  })

  it('citácia dostane štýl, aby vyzerala ako citácia aj v iných programoch', () => {
    expect(outgoingHtml('<blockquote><p>x</p></blockquote>')).toMatch(/<blockquote style="margin:0 0 0 0\.8ex;border-left:2px solid #c9d1dc/)
  })
})
