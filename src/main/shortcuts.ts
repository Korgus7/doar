import { app, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Doar Mail sa na Windowse dodáva ako priečinok (bez inštalátora – pozri electron-builder.yml).
 * Odkazy s vlastnou ikonou si preto vytvorí sám:
 * - ponuka Štart: vždy (Windows na ňu viaže aj systémové oznámenia – AppUserModelID),
 * - plocha: len pri prvom spustení (keď ho používateľ zmaže, už sa nevráti),
 * - po presune priečinka aplikácie sa existujúce odkazy opravia.
 */
export function ensureShortcuts(name: string, appUserModelId: string): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const target = process.execPath
  const opts = { target, cwd: dirname(target), icon: join(process.resourcesPath, 'icon.ico'), iconIndex: 0, appUserModelId, description: name }
  const startMenu = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`)
  const desktop = join(app.getPath('desktop'), `${name}.lnk`)
  const stateFile = join(app.getPath('userData'), 'shortcuts.json')
  let firstRun = true
  try {
    firstRun = !(JSON.parse(readFileSync(stateFile, 'utf8')) as { created?: boolean }).created
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
  if (!existsSync(startMenu)) write(startMenu, 'create')
  else if (!pointsHere(startMenu)) write(startMenu, 'replace')
  if (firstRun) {
    if (!existsSync(desktop)) write(desktop, 'create')
    try {
      writeFileSync(stateFile, JSON.stringify({ created: true }))
    } catch {
      // nevadí – pri ďalšom spustení sa len znova skontroluje
    }
  } else if (existsSync(desktop) && !pointsHere(desktop)) write(desktop, 'replace')
}
