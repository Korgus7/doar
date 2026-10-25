import { describe, it, expect } from 'vitest'
import sk from '../../src/renderer/src/i18n/sk.json'
import en from '../../src/renderer/src/i18n/en.json'
import cs from '../../src/renderer/src/i18n/cs.json'
import de from '../../src/renderer/src/i18n/de.json'
import hu from '../../src/renderer/src/i18n/hu.json'
import fr from '../../src/renderer/src/i18n/fr.json'
import es from '../../src/renderer/src/i18n/es.json'
import ru from '../../src/renderer/src/i18n/ru.json'
import he from '../../src/renderer/src/i18n/he.json'
import { UI_LOCALES, LOCALE_NAMES, RTL_LOCALES, isUiLocale, pickUiLocale } from '../../src/shared/ipc'

const ALL: Record<string, Record<string, string>> = { sk, en, cs, de, hu, fr, es, ru, he }
const params = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()

describe('preklady', () => {
  it('každý jazyk z UI_LOCALES má súbor prekladov a názov', () => {
    expect(Object.keys(ALL).sort()).toEqual([...UI_LOCALES].sort())
    for (const l of UI_LOCALES) expect(LOCALE_NAMES[l].trim()).not.toBe('')
    expect(RTL_LOCALES).toEqual(['he'])
  })

  for (const [lang, dict] of Object.entries(ALL)) {
    it(`${lang}: presne tie isté kľúče ako slovenčina, nič prázdne, rovnaké parametre`, () => {
      expect(Object.keys(dict).sort()).toEqual(Object.keys(sk).sort())
      for (const [k, v] of Object.entries(sk)) {
        const t = dict[k]!
        expect(t.trim(), `${lang} ${k}`).not.toBe('')
        expect(params(t), `${lang} ${k}`).toEqual(params(v))
      }
    })
  }

  it('hebrejčina je naozaj po hebrejsky (nie skopírovaná angličtina)', () => {
    const hebrew = Object.values(he).filter((v) => /[֐-׿]/.test(v)).length
    expect(hebrew / Object.keys(he).length).toBeGreaterThan(0.9)
  })

  it('ruština je naozaj v azbuke', () => {
    const cyr = Object.values(ru).filter((v) => /[а-яё]/i.test(v)).length
    expect(cyr / Object.keys(ru).length).toBeGreaterThan(0.9)
  })

  it('jazyk systému → jazyk rozhrania', () => {
    expect(pickUiLocale('sk-SK')).toBe('sk')
    expect(pickUiLocale('cs')).toBe('cs')
    expect(pickUiLocale('de_AT')).toBe('de')
    expect(pickUiLocale('he-IL')).toBe('he')
    expect(pickUiLocale('iw')).toBe('he')
    expect(pickUiLocale('fr-FR')).toBe('fr')
    expect(pickUiLocale('es-MX')).toBe('es')
    expect(pickUiLocale('ru')).toBe('ru')
    expect(pickUiLocale('pt-BR')).toBe('en')
    expect(pickUiLocale(undefined)).toBe('en')
    expect(isUiLocale('hu')).toBe(true)
    expect(isUiLocale('xx')).toBe(false)
  })
})
