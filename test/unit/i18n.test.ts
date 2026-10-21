import { describe, it, expect } from 'vitest'
import sk from '../../src/renderer/src/i18n/sk.json'
import en from '../../src/renderer/src/i18n/en.json'

describe('preklady', () => {
  it('angličtina má presne tie isté kľúče ako slovenčina', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(sk).sort())
  })
  it('žiadny preklad nie je prázdny a parametre sedia', () => {
    for (const [k, v] of Object.entries(sk)) {
      const e = (en as Record<string, string>)[k]!
      expect(v.trim(), k).not.toBe('')
      expect(e.trim(), k).not.toBe('')
      expect((e.match(/\{\w+\}/g) ?? []).sort(), k).toEqual((v.match(/\{\w+\}/g) ?? []).sort())
    }
  })
})
