/**
 * Vzhľad: podľa systému / svetlý / tmavý. Voľba sa pamätá v localStorage (spoločný pre všetky okná),
 * na dokumente sa prejaví cez data-theme a hlavný proces nastaví nativeTheme (titulok okna, posuvníky).
 */
export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'doar.theme'

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === 'system' || v === 'light' || v === 'dark'
}

export function themeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return isThemeChoice(v) ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply(choice: ThemeChoice): void {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', choice)
  window.doar?.setTheme?.(choice)
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    // nezapamätá sa – platí aspoň do zatvorenia okna
  }
  apply(choice)
}

/** Pri štarte okna: použiť uloženú voľbu a sledovať zmeny z iných okien. */
export function initTheme(): void {
  apply(themeChoice())
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) apply(themeChoice())
  })
}
