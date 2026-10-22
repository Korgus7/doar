import sk from './sk.json'
import en from './en.json'

/**
 * Jednoduché preklady. Kľúče sú v sk.json (zdroj pravdy); en.json musí mať rovnaké kľúče
 * (kontroluje unit test). Ďalší jazyk = nový JSON + záznam v LOCALES.
 */
export type MessageKey = keyof typeof sk
const LOCALES = { sk, en } as const satisfies Record<string, Record<MessageKey, string>>
export type Locale = keyof typeof LOCALES
export const AVAILABLE_LOCALES = Object.keys(LOCALES) as Locale[]

function pickLocale(requested: string | null | undefined): Locale {
  const base = (requested ?? '').toLowerCase().split(/[-_]/)[0] ?? ''
  if (base in LOCALES) return base as Locale
  // Čeština a slovenčina → slovenčina, ostatné → angličtina.
  return base === 'cs' ? 'sk' : 'en'
}

const STORAGE_KEY = 'doar.locale'

function storedLocale(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Voľba používateľa: konkrétny jazyk, alebo „podľa systému“. */
export function localeChoice(): Locale | 'auto' {
  const s = storedLocale()
  return s === 'sk' || s === 'en' ? s : 'auto'
}

export const i18n = $state({ locale: pickLocale(storedLocale() ?? window.doar?.locale) })

export function setLocale(locale: Locale | 'auto'): void {
  try {
    if (locale === 'auto') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // ignorovať – jazyk sa len nezapamätá
  }
  i18n.locale = locale === 'auto' ? pickLocale(window.doar?.locale) : locale
  document.documentElement.lang = i18n.locale
  window.doar?.setUiLocale(i18n.locale)
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const msg = LOCALES[i18n.locale][key] ?? LOCALES.sk[key] ?? key
  if (!params) return msg
  return msg.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`))
}
