import { app, shell } from 'electron'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Doar sa na Windowse dodáva ako priečinok (bez inštalátora – pozri electron-builder.yml).
 * Odkazy s vlastnou ikonou si preto vytvorí sám:
 * - ponuka Štart: vždy (Windows na ňu viaže aj systémové oznámenia – AppUserModelID),
 * - plocha: pri prvom spustení a po spustení z iného priečinka (nová verzia rozbalená inam);
 *   keď ho používateľ zmaže a program je stále na tom istom mieste, už sa nevráti,
 * - po presune priečinka aplikácie sa existujúce odkazy opravia.
 */
export function ensureShortcuts(name: string, appUserModelId: string): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const target = process.execPath
  const opts = { target, cwd: dirname(target), icon: join(process.resourcesPath, 'icon.ico'), iconIndex: 0, appUserModelId, description: name }
  const startMenu = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`)
  const desktop = join(app.getPath('desktop'), `${name}.lnk`)
  const stateFile = join(app.getPath('userData'), 'shortcuts.json')
  // Pre aký program (cestu) bol odkaz na ploche naposledy vytvorený. Nový priečinok (napr. nová verzia
  // rozbalená vedľa starej) = odkaz sa vytvorí znova; ten istý priečinok a zmazaný odkaz = používateľ ho nechce.
  let state: { created?: boolean; target?: string } = {}
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8')) as { created?: boolean; target?: string }
  } catch {
    // prvé spustenie
  }
  const write = (path: string, mode: 'create' | 'replace'): void => {
    try {
      shell.writeShortcutLink(path, mode, opts)
    } catch {
      // odkaz nie je nevyhnutný – aplikácia funguje aj bez neho
    }
  }
  const pointsHere = (path: string): boolean => {
    try {
      return shell.readShortcutLink(path).target.toLowerCase() === target.toLowerCase()
    } catch {
      return false
    }
  }
  removeLegacy()
  updatePinned(target, opts)
  if (!existsSync(startMenu)) write(startMenu, 'create')
  else if (!pointsHere(startMenu)) write(startMenu, 'replace')
  const movedHere = !state.created || (state.target ?? '').toLowerCase() !== target.toLowerCase()
  if (movedHere) {
    write(desktop, existsSync(desktop) ? 'replace' : 'create')
    try {
      writeFileSync(stateFile, JSON.stringify({ created: true, target }))
    } catch {
      // nevadí – pri ďalšom spustení sa len znova skontroluje
    }
  } else if (existsSync(desktop) && !pointsHere(desktop)) write(desktop, 'replace')
}

/** Na požiadanie (Nastavenia): vytvorí odkaz na ploche aj v ponuke Štart znova (napr. po zmazaní). */
export function recreateShortcuts(name: string, appUserModelId: string): boolean {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  const target = process.execPath
  const opts = { target, cwd: dirname(target), icon: join(process.resourcesPath, 'icon.ico'), iconIndex: 0, appUserModelId, description: name }
  try {
    writeFileSync(join(app.getPath('userData'), 'shortcuts.json'), JSON.stringify({ created: true, target }))
  } catch {
    // nevadí
  }
  let ok = true
  for (const path of [join(app.getPath('desktop'), `${name}.lnk`), join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`)]) {
    try {
      ok = shell.writeShortcutLink(path, existsSync(path) ? 'replace' : 'create', opts) && ok
    } catch {
      ok = false
    }
  }
  return ok
}

/**
 * Do 0.10 sa program volal „Doar Mail“ – jeho odkazy („Doar Mail.lnk“) by po premenovaní zostali vedľa nových
 * a viedli na starú verziu. Zmažú sa len tie, ktoré naozaj vedú na „Doar Mail.exe“.
 */
function removeLegacy(): void {
  for (const path of [join(app.getPath('desktop'), 'Doar Mail.lnk'), join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Doar Mail.lnk')]) {
    try {
      if (existsSync(path) && basename(shell.readShortcutLink(path).target).toLowerCase() === 'doar mail.exe') unlinkSync(path)
    } catch {
      // nevadí – starý odkaz len zostane
    }
  }
}

/**
 * Ikona pripnutá na paneli úloh je odkaz v „User Pinned\TaskBar“ – po aktualizácii by ďalej spúšťala
 * starú verziu. Pripnuté odkazy na Doar (Doar.exe / Doar Mail.exe v priečinku s inštaláciou) sa presmerujú sem.
 */
function updatePinned(target: string, opts: Electron.ShortcutDetails): void {
  const dir = join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.lnk'))
  } catch {
    return
  }
  for (const n of names) {
    const path = join(dir, n)
    try {
      const old = shell.readShortcutLink(path).target
      const exe = basename(old).toLowerCase()
      if ((exe !== 'doar.exe' && exe !== 'doar mail.exe') || old.toLowerCase() === target.toLowerCase()) continue
      // Len odkaz na inštaláciu Doaru (vedľa programu je resources\app.asar alebo už neexistuje).
      if (existsSync(old) && !existsSync(join(dirname(old), 'resources', 'app.asar'))) continue
      shell.writeShortcutLink(path, 'update', opts)
    } catch {
      // nevadí – ikona len ostane na starej verzii (tá prepne na novšiu sama)
    }
  }
}
