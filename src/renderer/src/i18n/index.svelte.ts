import sk from './sk.json'
import en from './en.json'
import cs from './cs.json'
import de from './de.json'
import hu from './hu.json'
import fr from './fr.json'
import es from './es.json'
import ru from './ru.json'
import he from './he.json'
import { pickUiLocale, isUiLocale, RTL_LOCALES, UI_LOCALES, type UiLocale } from '../../../shared/ipc'

/**
 * Jednoduché preklady. Kľúče sú v sk.json (zdroj pravdy); ostatné jazyky musia mať rovnaké kľúče
 * a rovnaké {parametre} (kontroluje unit test). Ďalší jazyk = nový JSON + záznam v LOCALES a v UI_LOCALES.
 */
export type MessageKey = keyof typeof sk
const LOCALES: Record<UiLocale, Record<MessageKey, string>> = { sk, en, cs, de, hu, fr, es, ru, he }
export type Locale = UiLocale
export const AVAILABLE_LOCALES: readonly Locale[] = UI_LOCALES

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
  return isUiLocale(s) ? s : 'auto'
}

export const i18n = $state({ locale: pickUiLocale(storedLocale() ?? window.doar?.locale) })

/** Jazyk a smer písma celého okna (hebrejčina sprava doľava). */
export function isRtl(locale: Locale = i18n.locale): boolean {
  return RTL_LOCALES.includes(locale)
}

function applyToDocument(): void {
  document.documentElement.lang = i18n.locale
  document.documentElement.dir = isRtl() ? 'rtl' : 'ltr'
}
applyToDocument()

export function setLocale(locale: Locale | 'auto'): void {
  try {
    if (locale === 'auto') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // ignorovať – jazyk sa len nezapamätá
  }
  i18n.locale = locale === 'auto' ? pickUiLocale(window.doar?.locale) : locale
  applyToDocument()
  window.doar?.setUiLocale(i18n.locale)
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const msg = LOCALES[i18n.locale][key] ?? LOCALES.sk[key] ?? key
  if (!params) return msg
  return msg.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`))
}
