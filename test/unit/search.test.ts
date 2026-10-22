import { describe, it, expect } from 'vitest'
import { openDb } from '../../src/core/store/db'
import { buildFtsQuery, parseSearch } from '../../src/core/search'

function matches(rows: [string, string, string, string][], input: string): number[] {
  const db = openDb(':memory:')
  const ins = db.prepare('INSERT INTO messages_fts(rowid, subject, from_text, to_text, body_text) VALUES (?, ?, ?, ?, ?)')
  rows.forEach((r, i) => ins.run(i + 1, ...r))
  const q = buildFtsQuery(input)
  if (!q) return []
  const out = (db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid').all(q) as { rowid: number }[]).map((r) => r.rowid)
  db.close()
  return out
}

const MAIL: [string, string, string, string][] = [
  ['Faktúra za október', 'Ján Novák jan@firma.sk', 'eva@mail.sk', 'Dobrý deň, posielam faktúru č. 2026/015.'],
  ['Žiadosť o dovolenku', 'Eva Malá eva@mail.sk', 'sef@firma.sk', 'Prosím o schválenie dovolenky v júli.'],
  ['Re: obed', 'Peter peter@x.sk', 'jan@firma.sk', 'Ideme o 12:00 do jedálne Faktor.'],
  ['Cenová ponuka', 'Obchod obchod@shop.sk', 'jan@firma.sk', 'Ponuka platí do konca mesiaca.']
]

describe('vyhľadávanie', () => {
  it('bez diakritiky, začiatok slova, veľké písmená', () => {
    expect(matches(MAIL, 'ziadost')).toEqual([2])
    expect(matches(MAIL, 'FAKTUR')).toEqual([1])
    expect(matches(MAIL, 'fakt')).toEqual([1, 3])
    expect(matches(MAIL, 'dovolenk')).toEqual([2])
  })

  it('všetky slová musia byť v správe', () => {
    expect(matches(MAIL, 'faktúr október')).toEqual([1])
    expect(matches(MAIL, 'faktúr júl')).toEqual([])
  })

  it('polia od:, komu:, predmet: (aj anglicky)', () => {
    expect(matches(MAIL, 'od:jan')).toEqual([1])
    expect(matches(MAIL, 'komu:jan')).toEqual([3, 4])
    expect(matches(MAIL, 'predmet:ponuka')).toEqual([4])
    expect(matches(MAIL, 'subject:obed from:peter')).toEqual([3])
  })

  it('fráza v úvodzovkách a e-mailová adresa', () => {
    expect(matches(MAIL, '"cenová ponuka"')).toEqual([4])
    expect(matches(MAIL, '"ponuka cenová"')).toEqual([])
    expect(matches(MAIL, 'obchod@shop.sk')).toEqual([4])
  })

  it('syntax FTS5 od používateľa sa neinterpretuje a nič nezhodí', () => {
    for (const bad of ['NOT faktúra', 'a OR b', 'body_text:x', '"', '***', '(', 'NEAR(a b)', '^x', 'col:"x', '- -']) {
      expect(() => matches(MAIL, bad), bad).not.toThrow()
    }
    expect(matches(MAIL, 'NOT faktúra')).toEqual([]) // „not“ sa hľadá ako slovo
    expect(buildFtsQuery('   ')).toBeNull()
    expect(buildFtsQuery('!!! ---')).toBeNull()
  })

  it('neznáma predpona je obyčajný text', () => {
    expect(parseSearch('https://firma.sk')).toEqual([{ field: null, text: 'https://firma.sk', phrase: false }])
    expect(parseSearch('o 12:00')[1]).toEqual({ field: null, text: '12:00', phrase: false })
    expect(matches(MAIL, '12:00')).toEqual([3])
  })
})
