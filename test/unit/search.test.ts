import { describe, it, expect } from 'vitest'
import { openDb } from '../../src/core/store/db'
import { buildFtsQuery, buildSearch, flagsWhere, parseDate, parseSearch } from '../../src/core/search'

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

describe('rozšírené hľadanie', () => {
  it('filtre v texte: príloha, neprečítané, hviezdička, dátum (aj slovensky a bez diakritiky)', () => {
    const r = buildSearch('faktúra má:prílohu je:neprecitane is:flagged po:1.10.2026 before:2026-10-31')!
    expect(r.fts).toBe('"faktúra"*')
    expect(r.flags).toEqual({ after: '2026-10-01', before: '2026-10-31', attachment: true, unread: true, flagged: true })
    // Neplatný dátum je obyčajný text.
    expect(buildSearch('po:32.13.2026')!.fts).toBe('"po:32.13.2026"*')
    expect(parseDate('29.2.2025')).toBeNull()
    expect(parseDate('29. 2. 2024')).toBe('2024-02-29')
  })

  it('formulár: polia od/komu/predmet a filtre; samotný filter bez textu stačí', () => {
    const r = buildSearch('', { from: 'jan', subject: 'cenová ponuka', after: '2026-01-01', attachment: true })!
    expect(r.fts).toBe('from_text : "jan"* AND subject : "cenová"* AND subject : "ponuka"*')
    expect(r.flags.after).toBe('2026-01-01')
    expect(buildSearch('', { unread: true })).toEqual({ fts: null, flags: expect.objectContaining({ unread: true }) })
    expect(buildSearch('', {})).toBeNull()
    expect(buildSearch('  ', { from: '  ' })).toBeNull()
  })

  it('podmienka SQL: „do“ vrátane celého dňa', () => {
    const w = flagsWhere({ after: '2026-10-01', before: '2026-10-31', attachment: true, unread: false, flagged: true }, 'm.date')
    expect(w.where).toBe('m.date >= ? AND m.date < ? AND m.has_attachments = 1 AND m.flagged = 1')
    expect(w.args).toEqual(['2026-10-01T00:00:00', '2026-11-01T00:00:00'])
  })
})
