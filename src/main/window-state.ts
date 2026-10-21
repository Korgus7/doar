import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Zapamätanie veľkosti, polohy a maximalizácie okna medzi spusteniami. */
export interface WindowState {
  bounds: Partial<Rectangle> & { width: number; height: number }
  maximized: boolean
}

const DEFAULT: WindowState = { bounds: { width: 1280, height: 800 }, maximized: false }

export function loadWindowState(file: string): WindowState {
  try {
    if (!existsSync(file)) return DEFAULT
    const s = JSON.parse(readFileSync(file, 'utf8')) as WindowState
    const b = s.bounds
    if (!b || !(b.width >= 400) || !(b.height >= 300)) return DEFAULT
    // Okno musí byť aspoň čiastočne na niektorom z pripojených monitorov (napr. po odpojení druhého).
    if (b.x !== undefined && b.y !== undefined) {
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea
        return b.x! < a.x + a.width - 50 && b.x! + b.width > a.x + 50 && b.y! < a.y + a.height - 50 && b.y! + b.height > a.y
      })
      if (!visible) return { bounds: { width: b.width, height: b.height }, maximized: !!s.maximized }
    }
    return { bounds: b, maximized: !!s.maximized }
  } catch {
    return DEFAULT
  }
}

export function trackWindowState(win: BrowserWindow, file: string): void {
  const save = (): void => {
    try {
      const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
      writeFileSync(file, JSON.stringify(state))
    } catch {
      /* nezapamätá sa – nevadí */
    }
  }
  win.on('close', save)
}
