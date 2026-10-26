import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, nativeImage, nativeTheme, Notification, powerMonitor, session, shell, utilityProcess, type UtilityProcess } from 'electron'
import { deflateSync } from 'node:zlib'
import { basename, join, relative, isAbsolute } from 'node:path'
import { statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SecretStore } from './secrets'
import { buildMenu, showAbout, systemUiLocale, translate } from './menu'
import { loadWindowState, trackWindowState } from './window-state'
import { ensureShortcuts } from './shortcuts'
import { Updater } from './updater'
import type { CoreToMain, MainToCore, UiLocale } from '../shared/ipc'
import { incompletePath, isComposeMode, isDangerousFile, isUiLocale, OPEN_ATTACHMENTS_DIR, type ComposeMode, type PickedFile } from '../shared/ipc'

const here = fileURLToPath(new URL('.', import.meta.url))
const DEV_URL = process.env['ELECTRON_RENDERER_URL']
/** Zobrazovaný názov aplikácie (okná, tlač, O aplikácii). */
const APP_NAME = 'Doar Mail'
/** Ikona okna a panela úloh (zdroj: resources/icon.svg). */
const APP_ICON = join(app.getAppPath(), 'resources', 'icon.png')

// Samostatný dátový priečinok (testy, prenosná verzia).
// Dátový priečinok je vždy „Doar“ (nezávisle od zobrazovaného názvu „Doar Mail“), aby sa pri premenovaní nestratili kontá ani pošta.
if (process.env['DOAR_DATA_DIR']) app.setPath('userData', process.env['DOAR_DATA_DIR'])
else app.setPath('userData', join(app.getPath('appData'), 'Doar'))

// Žiadna telemetria, žiadne zbytočné služby Chromia.
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess')

let core: UtilityProcess | null = null
let mainWindow: BrowserWindow | null = null
let secrets: SecretStore
let coreReady = false
let uiLocale: UiLocale = 'sk'
/** Všetky okná aplikácie (hlavné + okná správ) a tie, ktorých stránka je načítaná. */
const appWindows = new Set<BrowserWindow>()
const loadedWindows = new Set<BrowserWindow>()
/** Okná správ, ktoré sa môžu zavrieť bez otázky (rozhranie potvrdilo). */
const allowClose = new WeakSet<BrowserWindow>()

function startCore(): UtilityProcess {
  const child = utilityProcess.fork(join(here, 'core.js'), [], { serviceName: 'Doar Core', stdio: 'inherit' })
  const init: MainToCore = { kind: 'init', dataDir: app.getPath('userData'), appVersion: app.getVersion() }
  child.postMessage(init)

  child.on('message', (msg: CoreToMain) => {
    if (msg.kind === 'ready') {
      coreReady = true
      for (const w of loadedWindows) connectWindow(w)
      return
    }
    if (msg.kind === 'newMail') {
      showNewMail(msg)
      return
    }
    const reply = (r: Omit<Extract<MainToCore, { kind: 'secret.result' }>, 'kind'>): void =>
      child.postMessage({ kind: 'secret.result', ...r } satisfies MainToCore)
    // Šifrovanie systému beží asynchrónne – odpoveď jadru príde, keď je hotové.
    void (async () => {
      try {
        if (msg.kind === 'secret.get') reply({ id: msg.id, ok: true, value: await secrets.get(msg.key) })
        else if (msg.kind === 'secret.set') {
          await secrets.set(msg.key, msg.value)
          reply({ id: msg.id, ok: true })
        } else if (msg.kind === 'secret.delete') {
          secrets.delete(msg.key)
          reply({ id: msg.id, ok: true })
        } else if (msg.kind === 'secret.status') {
          reply({ id: msg.id, ok: true, value: (await secrets.status()).available ? 'secure' : 'insecure' })
        }
      } catch (e) {
        reply({ id: (msg as { id: number }).id, ok: false, error: e instanceof Error ? e.message : 'ERROR' })
      }
    })()
  })

  child.on('exit', (code) => {
    console.error(`[main] core skončil (kód ${code})`)
    core = null
    coreReady = false
    if (!quitting) {
      // Jeden pokus o reštart, aby aplikácia nezostala bez jadra.
      setTimeout(() => {
        if (!quitting && !core) core = startCore()
      }, 1000)
    }
  })
  return child
}

/** Systémové oznámenie o novej pošte. Keď je Doar práve v popredí, neruší. Kliknutie otvorí správu. */
function showNewMail(m: Extract<CoreToMain, { kind: 'newMail' }>): void {
  if (!Notification.isSupported() || (mainWindow?.isFocused() && mainWindow.isVisible())) return
  const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>): string => translate(uiLocale, k, p)
  const title = m.count > 1 ? t('notify.titleMany', { n: m.count, account: m.accountEmail }) : t('notify.title', { account: m.accountEmail })
  const body = m.from !== null ? `${m.from}\n${m.subject || t('list.noSubject')}` : t('notify.hidden')
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('menu-action', `open-message:${m.messageId}`)
  })
  n.show()
}

/** Malý červený krúžok (PNG) – odznak „neprečítané“ na ikone v paneli úloh Windows. */
function dotImage(): Electron.NativeImage {
  const size = 16
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5)
      const a = Math.max(0, Math.min(1, 7.5 - d)) // vyhladený okraj
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = 0xb3
      raw[o + 1] = 0x26
      raw[o + 2] = 0x1e
      raw[o + 3] = Math.round(a * 255)
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bitová hĺbka
  ihdr[9] = 6 // RGBA
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return nativeImage.createFromBuffer(png)
}

let unreadDot: Electron.NativeImage | null = null
function setUnread(n: number): void {
  app.setBadgeCount(n) // macOS, Linux (Unity)
  if (process.platform === 'win32' && mainWindow) {
    unreadDot ??= dotImage()
    mainWindow.setOverlayIcon(n > 0 ? unreadDot : null, n > 0 ? translate(uiLocale, 'notify.unread', { n }) : '')
  }
}

/** Prepojí okno priamo s core cez MessagePort (main nič nepreposiela). */
function connectWindow(win: BrowserWindow): void {
  if (!core || !coreReady) return
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage({ kind: 'port' }, [port1])
  win.webContents.postMessage('core-port', null, [port2])
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(here, '../preload/index.cjs'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: true,
    additionalArguments: [`--doar-locale=${app.getLocale()}`]
  }
}

/** Spoločné pre všetky okná: evidencia, prepojenie s jadrom po načítaní stránky. */
function registerWindow(win: BrowserWindow, query: Record<string, string> = {}): void {
  appWindows.add(win)
  win.on('closed', () => {
    appWindows.delete(win)
    loadedWindows.delete(win)
  })
  win.webContents.on('did-start-loading', () => loadedWindows.delete(win))
  win.webContents.on('did-finish-load', () => {
    loadedWindows.add(win)
    connectWindow(win)
  })
  const qs = new URLSearchParams(query).toString()
  if (DEV_URL) void win.loadURL(qs ? `${DEV_URL}?${qs}` : DEV_URL)
  else void win.loadFile(join(here, '../renderer/index.html'), { query })
}

function createWindow(): BrowserWindow {
  const stateFile = join(app.getPath('userData'), 'window-state.json')
  const state = loadWindowState(stateFile)
  const win = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    icon: APP_ICON,
    backgroundColor: '#00000000',
    webPreferences: webPreferences()
  })
  // Klasické menu (Súbor, Úpravy…) sa nezobrazuje – všetko je v ponuke ☰. Klávesové skratky z neho fungujú ďalej.
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    if (state.maximized) win.maximize()
    win.show()
  })
  trackWindowState(win, stateFile)
  registerWindow(win)
  return win
}

/** Okno na písanie správy (samostatné, ako v Outlook Expresse). */
function createComposeWindow(mode: ComposeMode, messageId?: number): BrowserWindow {
  const parent = mainWindow
  const b = parent?.getBounds()
  const win = new BrowserWindow({
    width: 820,
    height: 680,
    minWidth: 520,
    minHeight: 400,
    ...(b ? { x: b.x + 60, y: b.y + 40 } : {}),
    show: false,
    title: APP_NAME,
    icon: APP_ICON,
    webPreferences: webPreferences()
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  // Zatvorenie okna s rozpísanou správou: najprv sa opýta rozhranie (neuložený text).
  win.on('close', (e) => {
    if (allowClose.has(win) || quitting) return
    e.preventDefault()
    win.webContents.send('close-request')
  })
  registerWindow(win, { compose: mode, ...(messageId ? { id: String(messageId) } : {}) })
  return win
}

function senderWindow(e: Electron.IpcMainEvent): BrowserWindow | null {
  const w = BrowserWindow.fromWebContents(e.sender)
  return w && appWindows.has(w) ? w : null
}

/** Bezpečnostné pravidlá pre všetok webový obsah v aplikácii. */
function hardenSecurity(): void {
  app.on('web-contents-created', (_e, contents) => {
    // Žiadne nové okná z obsahu; odkazy http/https/mailto otvoríme v systémovom prehliadači.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (e, url) => {
      if (DEV_URL && url.startsWith(DEV_URL)) return
      e.preventDefault()
    })
    contents.on('will-attach-webview', (e) => e.preventDefault())
  })

  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  // Rozhranie nesmie samo ísť na internet (sledovacie obrázky a pod.).
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url
    const allowed =
      u.startsWith('file:') ||
      u.startsWith('data:') ||
      u.startsWith('blob:') ||
      u.startsWith('devtools:') ||
      (DEV_URL !== undefined && (u.startsWith(DEV_URL) || u.startsWith(DEV_URL.replace(/^http/, 'ws'))))
    cb({ cancel: !allowed })
  })
}

let quitting = false
let updater: Updater | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'))
    hardenSecurity()
    uiLocale = systemUiLocale()
    buildMenu(uiLocale, () => mainWindow, DEV_URL !== undefined)
    // Windows: oznámenia sa zobrazia pod menom aplikácie (nie „electron.app.Electron“).
    if (process.platform === 'win32') app.setAppUserModelId('sk.doar.app')
    // Balík bez inštalátora: odkazy v ponuke Štart a na ploche si aplikácia vytvorí sama.
    ensureShortcuts(APP_NAME, 'sk.doar.app')
    // Aktualizácie (GitHub Releases) – nič sa nestiahne bez súhlasu používateľa.
    updater = new Updater(() => [...appWindows])
    ipcMain.handle('update-state', () => updater!.getState())
    ipcMain.on('update-cmd', (e, cmd: unknown) => {
      if (!mainWindow || e.sender !== mainWindow.webContents || !updater) return
      if (cmd === 'check') void updater.check(true)
      else if (cmd === 'download') void updater.download()
      else if (cmd === 'cancel') updater.cancel()
      else if (cmd === 'restart') updater.restart()
      else if (cmd === 'auto-on' || cmd === 'auto-off') updater.setAuto(cmd === 'auto-on')
      else if (cmd === 'open-page') updater.openPage()
    })
    updater.start()
    // Tlač správy: dokument pripraví rozhranie (prečistené HTML z jadra), vytlačí ho skryté okno bez skriptov a siete.
    ipcMain.on('print-html', (e, html: unknown, title: unknown) => {
      const owner = senderWindow(e)
      if (!owner || typeof html !== 'string' || html.length > 30_000_000) return
      const file = join(tmpdir(), `doar-tlac-${randomUUID()}.html`)
      writeFileSync(file, html, { encoding: 'utf8', mode: 0o600 })
      const w = new BrowserWindow({
        show: false,
        parent: owner,
        title: typeof title === 'string' ? title.slice(0, 200) : APP_NAME,
        webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
      })
      const cleanup = (): void => {
        if (!w.isDestroyed()) w.close()
        rmSync(file, { force: true })
      }
      w.webContents.once('did-finish-load', () => {
        w.webContents.print({ printBackground: true }, () => cleanup())
      })
      w.webContents.once('did-fail-load', cleanup)
      void w.loadFile(file)
    })
    ipcMain.on('unread-count', (e, n: unknown) => {
      if (!mainWindow || e.sender !== mainWindow.webContents || !Number.isInteger(n)) return
      setUnread(Math.max(0, Math.min(99_999, n as number)))
    })
    // Rozhranie oznamuje zvolený jazyk – menu sa prestaví. Prijímame len od nášho okna a len známe hodnoty.
    // Odkaz zo správy – len po kliknutí používateľa, len bezpečné schémy, len z našich okien.
    ipcMain.on('open-external', (e, url: unknown) => {
      if (!senderWindow(e) || typeof url !== 'string' || url.length > 4096) return
      try {
        const u = new URL(url)
        if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') void shell.openExternal(u.toString())
      } catch {
        /* neplatná adresa */
      }
    })
    ipcMain.on('ui-locale', (e, locale: unknown) => {
      if (!mainWindow || e.sender !== mainWindow.webContents) return
      if (isUiLocale(locale)) {
        uiLocale = locale
        buildMenu(locale, () => mainWindow, DEV_URL !== undefined)
        // Nové menu by sa vo Windows znova ukázalo – skryť ho vo všetkých oknách.
        for (const w of BrowserWindow.getAllWindows()) w.setMenuBarVisibility(false)
      }
    })
    // Vzhľad: nativeTheme prepne prefers-color-scheme vo všetkých oknách aj farbu titulku okna.
    ipcMain.on('ui-theme', (e, theme: unknown) => {
      if (!senderWindow(e)) return
      if (theme === 'system' || theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme
    })
    ipcMain.on('show-about', (e) => {
      if (mainWindow && e.sender === mainWindow.webContents) showAbout(mainWindow)
    })
    ipcMain.on('open-compose', (e, mode: unknown, messageId: unknown) => {
      if (!senderWindow(e)) return
      const m = isComposeMode(mode) ? mode : 'new'
      createComposeWindow(m, Number.isInteger(messageId) ? (messageId as number) : undefined)
    })
    // Záloha: súbor vyberá používateľ v natívnom dialógu; jadro smie zapisovať len do takto zvolenej cesty.
    const exportPaths = new Set<string>()
    ipcMain.handle('choose-export-file', async (e, name: unknown) => {
      const w = BrowserWindow.fromWebContents(e.sender)
      if (!w || w !== mainWindow) return null
      const safe = (typeof name === 'string' && name ? name : 'Doar.mbox').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150)
      const r = await dialog.showSaveDialog(w, {
        defaultPath: join(app.getPath('documents'), safe),
        filters: [{ name: 'mbox', extensions: ['mbox'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory']
      })
      if (r.canceled || !r.filePath) return null
      const path = /\.mbox$/i.test(r.filePath) ? r.filePath : `${r.filePath}.mbox`
      exportPaths.add(path)
      core?.postMessage({ kind: 'export.allow', path } satisfies MainToCore)
      return path
    })
    // Prílohy: cesty k súborom pochádzajú len z natívnych dialógov alebo z pretiahnutých súborov.
    const allow = (path: string, mode: 'read' | 'write' | 'dir' | 'tree'): void => core?.postMessage({ kind: 'files.allow', path, mode } satisfies MainToCore)
    const picked = (path: string): PickedFile | null => {
      try {
        const st = statSync(path)
        return st.isFile() ? { path, name: basename(path), size: st.size } : null
      } catch {
        return null
      }
    }
    const windowOf = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
      const w = BrowserWindow.fromWebContents(e.sender)
      return w && appWindows.has(w) ? w : null
    }
    // Obnova zo zálohy: súbor vyberá používateľ; jadro ho smie len čítať.
    ipcMain.handle('choose-import-file', async (e) => {
      const w = BrowserWindow.fromWebContents(e.sender)
      if (!w || w !== mainWindow) return null
      const r = await dialog.showOpenDialog(w, {
        defaultPath: app.getPath('documents'),
        filters: [
          { name: translate(uiLocale, 'restore.fileTypes'), extensions: ['mbox', 'mbx', 'pst', 'ost', 'dbx', 'eml'] },
          { name: '*', extensions: ['*'] }
        ],
        properties: ['openFile']
      })
      const path = r.canceled ? null : (r.filePaths[0] ?? null)
      if (!path || !picked(path)) return null
      allow(path, 'read')
      return path
    })
    // Import z Outlook Expressu a Windows Mail: priečinok s poštou; jadro ho smie len čítať.
    ipcMain.handle('choose-import-folder', async (e) => {
      const w = BrowserWindow.fromWebContents(e.sender)
      if (!w || w !== mainWindow) return null
      const r = await dialog.showOpenDialog(w, { defaultPath: app.getPath('documents'), properties: ['openDirectory'] })
      const path = r.canceled ? null : (r.filePaths[0] ?? null)
      if (!path) return null
      try {
        if (!statSync(path).isDirectory()) return null
      } catch {
        return null
      }
      allow(path, 'tree')
      return path
    })
    ipcMain.handle('choose-attach-files', async (e) => {
      const w = windowOf(e)
      if (!w) return []
      const r = await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'] })
      if (r.canceled) return []
      const out = r.filePaths.map(picked).filter((f): f is PickedFile => f !== null)
      for (const f of out) allow(f.path, 'read')
      return out
    })
    ipcMain.handle('dropped-files', (e, paths: unknown) => {
      if (!windowOf(e) || !Array.isArray(paths)) return []
      const out = paths
        .filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length < 4096 && isAbsolute(p))
        .slice(0, 100)
        .map(picked)
        .filter((f): f is PickedFile => f !== null)
      for (const f of out) allow(f.path, 'read')
      return out
    })
    ipcMain.handle('choose-save-path', async (e, name: unknown) => {
      const w = windowOf(e)
      if (!w) return null
      const safe = (typeof name === 'string' && name ? name : 'priloha').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200)
      const r = await dialog.showSaveDialog(w, { defaultPath: join(app.getPath('downloads'), safe), properties: ['showOverwriteConfirmation', 'createDirectory'] })
      if (r.canceled || !r.filePath) return null
      allow(r.filePath, 'write')
      return r.filePath
    })
    ipcMain.handle('choose-folder', async (e) => {
      const w = windowOf(e)
      if (!w) return null
      const r = await dialog.showOpenDialog(w, { defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      allow(r.filePaths[0], 'dir')
      return r.filePaths[0]
    })
    // Otvorenie prílohy: len dočasná kópia pripravená jadrom a nikdy nie spustiteľný súbor.
    ipcMain.handle('open-attachment-file', async (e, path: unknown) => {
      if (!windowOf(e) || typeof path !== 'string') return false
      const base = join(app.getPath('userData'), OPEN_ATTACHMENTS_DIR)
      const rel = relative(base, path)
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || isDangerousFile(path) || !picked(path)) return false
      return (await shell.openPath(path)) === ''
    })
    // Jeden koncept = jedno okno. Druhé okno s tým istým konceptom sa zavrie a ukáže sa to prvé.
    const draftWindows = new Map<number, BrowserWindow>()
    ipcMain.handle('claim-draft', (e, draftId: unknown) => {
      const w = windowOf(e)
      if (!w || !Number.isInteger(draftId)) return true
      const owner = draftWindows.get(draftId as number)
      if (owner && owner !== w && !owner.isDestroyed()) {
        if (owner.isMinimized()) owner.restore()
        owner.focus()
        return false
      }
      draftWindows.set(draftId as number, w)
      w.once('closed', () => {
        if (draftWindows.get(draftId as number) === w) draftWindows.delete(draftId as number)
      })
      return true
    })
    ipcMain.on('show-in-folder', (e, path: unknown) => {
      if (!senderWindow(e) || typeof path !== 'string') return
      if ([...exportPaths].some((p) => p === path || incompletePath(p) === path)) shell.showItemInFolder(path)
    })
    ipcMain.on('close-window', (e) => {
      const w = senderWindow(e)
      if (!w) return
      allowClose.add(w)
      w.close()
    })
    core = startCore()
    // Po prebudení počítača sa netreba spoliehať na odklad opakovania – pripojiť sa hneď.
    const reconnect = (): void => core?.postMessage({ kind: 'reconnect' } satisfies MainToCore)
    powerMonitor.on('resume', reconnect)
    powerMonitor.on('unlock-screen', reconnect)
    mainWindow = createWindow()
    mainWindow.on('closed', () => (mainWindow = null))
  })

  // Pri ukončení aplikácie sa okná správ zavrú bez otázky (quitting).

  app.on('before-quit', () => {
    quitting = true
    updater?.stop()
    core?.kill()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}
