import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, session, shell, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SecretStore } from './secrets'
import { buildMenu, systemUiLocale } from './menu'
import { loadWindowState, trackWindowState } from './window-state'
import type { CoreToMain, MainToCore } from '../shared/ipc'
import { incompletePath } from '../shared/ipc'

const here = fileURLToPath(new URL('.', import.meta.url))
const DEV_URL = process.env['ELECTRON_RENDERER_URL']

// Samostatný dátový priečinok (testy, prenosná verzia).
if (process.env['DOAR_DATA_DIR']) app.setPath('userData', process.env['DOAR_DATA_DIR'])

// Žiadna telemetria, žiadne zbytočné služby Chromia.
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess')

let core: UtilityProcess | null = null
let mainWindow: BrowserWindow | null = null
let secrets: SecretStore
let coreReady = false
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
    const reply = (r: Omit<Extract<MainToCore, { kind: 'secret.result' }>, 'kind'>): void =>
      child.postMessage({ kind: 'secret.result', ...r } satisfies MainToCore)
    try {
      if (msg.kind === 'secret.get') reply({ id: msg.id, ok: true, value: secrets.get(msg.key) })
      else if (msg.kind === 'secret.set') {
        secrets.set(msg.key, msg.value)
        reply({ id: msg.id, ok: true })
      } else if (msg.kind === 'secret.delete') {
        secrets.delete(msg.key)
        reply({ id: msg.id, ok: true })
      } else if (msg.kind === 'secret.status') {
        reply({ id: msg.id, ok: true, value: secrets.status().available ? 'secure' : 'insecure' })
      }
    } catch (e) {
      reply({ id: (msg as { id: number }).id, ok: false, error: e instanceof Error ? e.message : 'ERROR' })
    }
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
    title: 'Doar',
    backgroundColor: '#00000000',
    webPreferences: webPreferences()
  })
  win.once('ready-to-show', () => {
    if (state.maximized) win.maximize()
    win.show()
  })
  trackWindowState(win, stateFile)
  registerWindow(win)
  return win
}

/** Okno na písanie správy (samostatné, ako v Outlook Expresse). */
function createComposeWindow(mode: 'new' | 'reply' | 'replyAll', messageId?: number): BrowserWindow {
  const parent = mainWindow
  const b = parent?.getBounds()
  const win = new BrowserWindow({
    width: 820,
    height: 680,
    minWidth: 520,
    minHeight: 400,
    ...(b ? { x: b.x + 60, y: b.y + 40 } : {}),
    show: false,
    title: 'Doar',
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
    buildMenu(systemUiLocale(), () => mainWindow, DEV_URL !== undefined)
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
      if (locale === 'sk' || locale === 'en') buildMenu(locale, () => mainWindow, DEV_URL !== undefined)
    })
    ipcMain.on('open-compose', (e, mode: unknown, messageId: unknown) => {
      if (!senderWindow(e)) return
      const m = mode === 'reply' || mode === 'replyAll' ? mode : 'new'
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
    mainWindow = createWindow()
    mainWindow.on('closed', () => (mainWindow = null))
  })

  // Pri ukončení aplikácie sa okná správ zavrú bez otázky (quitting).

  app.on('before-quit', () => {
    quitting = true
    core?.kill()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}
