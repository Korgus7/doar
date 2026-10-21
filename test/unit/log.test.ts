import { describe, it, expect } from 'vitest'
import { redact } from '../../src/core/log'

describe('log bez citlivých údajov', () => {
  it('skryje heslá, tokeny, kľúče, predmety a telá správ', () => {
    const out = JSON.stringify(
      redact({ user: 'jan@firma.sk', password: 'tajne', apiKey: 'sk-ant-123456789', nested: { subject: 'Faktúra', body: 'text', accessToken: 'x' }, folder: 'INBOX' })
    )
    for (const secret of ['tajne', 'sk-ant-123456789', 'Faktúra', '"text"', '"x"']) expect(out).not.toContain(secret)
    expect(out).toContain('INBOX')
  })

  it('skryje heslo v IMAP príkaze v texte chyby', () => {
    const out = JSON.stringify(redact(new Error('Command failed: A1 LOGIN jan@firma.sk heslo123')))
    expect(out).not.toContain('heslo123')
  })
})
