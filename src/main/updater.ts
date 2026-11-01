import { app, session, shell, type BrowserWindow, type Session } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { UpdateState } from '../shared/ipc'
import { initLog, logger } from '../core/log'
import { cleanupOld, compareVersions, download, fromFolder, fromGithub, installBeside, looksLikeInstall, removeFile, type FetchLike, type UpdateInfo } from './update-core'

const REPO = 'Korgus7/doar'
const log = logger('update')
const FIRST_CHECK_MS = 30_000
const INTERVAL_MS = 12 * 60 * 60 * 1000

interface Prefs {
  auto: boolean
  /** Priečinky, z ktorých Doar bežal (posledný = aktuálny) – na upratanie starých verzií. */
  history: string[]
  /** Naposledy nainštalovaná verzia (staršia verzia spustená cez starý odkaz prepne na ňu). */
  installed?: { version: string; exe: string }
}

function codeOf(e: unknown): string {
  const c = (e as { code?: string })?.code
  if (c?.startsWith('UPDATE_')) return c
  const msg = String((e as Error)?.message ?? '')
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION/.test(msg)) return 'NO_NETWORK'
  return 'UPDATE_CHECK_FAILED'
}

/**
 * Aktualizácie Doar (main proces). Kontroluje GitHub Releases; nič nesťahuje bez súhlasu používateľa.
 * Testovací zdroj: premenná prostredia DOAR_UPDATE_FEED = priečinok s doar-update.json a zipom;
 * DOAR_UPDATE_API = náhradná adresa GitHub API (testy).
 */
export class Updater {
  private info: UpdateInfo | null = null
  private readyExe: string | null = null
  private controller: AbortController | null = null
  private timers: NodeJS.Timeout[] = []
  private prefs: Prefs
  private readonly prefsFile = join(app.getPath('userData'), 'update.json')
  private state: UpdateState

  constructor(private readonly getWindows: () => BrowserWindow[]) {
    initLog(app.getPath('userData'))
    this.prefs = this.loadPrefs()
    this.state = {
      phase: 'idle',
      current: app.getVersion(),
      version: null,
      notes: '',
      pageUrl: null,
      sizeBytes: 0,
      progress: 0,
      error: null,
      manual: false,
      auto: this.prefs.auto,
      // Verziu z Microsoft Store aktualizuje Store – Doar ju nesmie prepísať.
      canInstall: app.isPackaged && process.platform === 'win32' && !process.windowsStore,
      lastCheck: null
    }
  }

  private loadPrefs(): Prefs {
    try {
      const p = JSON.parse(readFileSync(this.prefsFile, 'utf8')) as Partial<Prefs>
      const inst = p.installed && typeof p.installed.version === 'string' && typeof p.installed.exe === 'string' ? { version: p.installed.version, exe: p.installed.exe } : undefined
      return { auto: p.auto !== false, history: Array.isArray(p.history) ? p.history.filter((x) => typeof x === 'string').slice(-10) : [], installed: inst }
    } catch {
      return { auto: true, history: [] }
    }
  }

  private savePrefs(): void {
    try {
      writeFileSync(this.prefsFile, JSON.stringify(this.prefs))
    } catch {
      // nevadí
    }
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    for (const w of this.getWindows()) if (!w.isDestroyed()) w.webContents.send('update-state', this.state)
  }

  getState(): UpdateState {
    return this.state
  }

  /**
   * Spustila sa staršia verzia, hoci je nainštalovaná novšia (napr. ikona pripnutá na paneli úloh ešte vedie
   * na starý priečinok)? Vráti cestu k novšej verzii – tá sa spustí namiesto tejto.
   */
  newerInstalled(): string | null {
    const inst = this.prefs.installed
    if (!this.state.canInstall || !inst) return null
    if (compareVersions(inst.version, app.getVersion()) <= 0) return null
    if (inst.exe.toLowerCase() === process.execPath.toLowerCase() || !existsSync(inst.exe) || !looksLikeInstall(dirname(inst.exe))) return null
    log.info('spustená staršia verzia – prepínam na novšiu', { current: app.getVersion(), newer: inst.version })
    return inst.exe
  }

  /** Po štarte: zapísať, odkiaľ beží, upratať staré verzie a naplánovať kontrolu. */
  start(): void {
    if (this.state.canInstall) {
      const cur = dirname(process.execPath)
      if (this.prefs.history.at(-1)?.toLowerCase() !== cur.toLowerCase()) this.prefs.history.push(cur)
      void cleanupOld(this.prefs.history, cur).then((keep) => {
        this.prefs.history = keep
        this.savePrefs()
      })
    }
    // Pri vývoji (npm run dev) sa automaticky nekontroluje – len na požiadanie.
    if (!app.isPackaged && !process.env['DOAR_UPDATE_FEED']) return
    if (process.windowsStore) return
    this.schedule()
  }

  private schedule(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    if (!this.prefs.auto) return
    this.timers.push(setTimeout(() => void this.check(false), FIRST_CHECK_MS))
    this.timers.push(setInterval(() => void this.check(false), INTERVAL_MS))
    for (const t of this.timers) t.unref?.()
  }

  setAuto(on: boolean): void {
    this.prefs.auto = on
    this.savePrefs()
    this.set({ auto: on })
    if ((app.isPackaged || process.env['DOAR_UPDATE_FEED']) && !process.windowsStore) this.schedule()
  }

  private ses: Session | null = null

  /**
   * Vlastná sieťová relácia len pre aktualizácie. Predvolená relácia okien má zablokovaný internet
   * (ochrana pred sledovaním v pošte) – tá blokáda sa aktualizácií netýka a okná ju majú naďalej.
   */
  private fetcher(): FetchLike {
    if (!this.ses) {
      this.ses = session.fromPartition('doar-update')
      this.ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
      this.ses.setPermissionCheckHandler(() => false)
    }
    const ses = this.ses
    return ((url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => ses.fetch(url, init)) as unknown as FetchLike
  }

  async check(manual: boolean): Promise<void> {
    const p = this.state.phase
    if (p === 'checking' || p === 'downloading' || p === 'installing' || p === 'ready') return
    this.set({ phase: 'checking', manual, error: null })
    try {
      const feed = process.env['DOAR_UPDATE_FEED']
      const info = feed ? await fromFolder(feed) : await fromGithub(this.fetcher(), REPO, undefined, process.env['DOAR_UPDATE_API'] || undefined)
      const now = new Date().toISOString()
      log.info('kontrola hotová', { manual, feed: feed ? 'priečinok' : process.env['DOAR_UPDATE_API'] ? 'test-api' : 'github', found: info?.version ?? null, current: app.getVersion() })
      if (!info || compareVersions(info.version, app.getVersion()) <= 0) {
        this.info = null
        this.set({ phase: 'none', version: null, lastCheck: now })
        return
      }
      this.info = info
      this.set({ phase: 'available', version: info.version, notes: info.notes, pageUrl: info.pageUrl, sizeBytes: info.size, lastCheck: now })
    } catch (e) {
      log.warn('kontrola zlyhala', { manual, error: e, cause: String((e as { cause?: { message?: string } })?.cause?.message ?? '') })
      // Automatická kontrola bez siete nič nehlási (skúsi sa neskôr); ručná povie prečo.
      this.set(manual ? { phase: 'error', error: codeOf(e) } : { phase: 'idle' })
    }
  }

  async download(): Promise<void> {
    const info = this.info
    if (!info || this.state.phase !== 'available') return
    if (!this.state.canInstall) {
      this.set({ phase: 'error', error: 'UPDATE_DEV' })
      return
    }
    this.controller = new AbortController()
    const zip = join(app.getPath('temp'), info.file)
    try {
      this.set({ phase: 'downloading', progress: 0, error: null })
      await download(this.fetcher(), info, zip, { signal: this.controller.signal, onProgress: (d, t) => this.progress(d / t) })
      this.set({ phase: 'installing', progress: 0 })
      // Ak sa vedľa bežiacej verzie nedá zapisovať (koreň disku, Program Files), použije sa %LOCALAPPDATA%\Programs.
      const local = process.env['LOCALAPPDATA']
      this.readyExe = await installBeside(zip, process.execPath, info.version, (d, t) => this.progress(d / t), local ? { fallbackParent: join(local, 'Programs') } : {})
      this.prefs.installed = { version: info.version, exe: this.readyExe }
      this.savePrefs()
      this.set({ phase: 'ready', progress: 1 })
    } catch (e) {
      log.warn('aktualizácia zlyhala', { version: info.version, error: e })
      this.set({ phase: (e as { code?: string }).code === 'UPDATE_CANCELLED' ? 'available' : 'error', error: (e as { code?: string }).code === 'UPDATE_CANCELLED' ? null : codeOf(e) })
    } finally {
      this.controller = null
      await removeFile(zip)
    }
  }

  private lastProgress = 0
  private progress(x: number): void {
    const now = Date.now()
    if (x < 1 && now - this.lastProgress < 200) return
    this.lastProgress = now
    this.set({ progress: Math.max(0, Math.min(1, x)) })
  }

  cancel(): void {
    this.controller?.abort()
  }

  /** Reštart do novej verzie. Odkazy na ploche a v ponuke Štart si nová verzia presmeruje sama pri štarte. */
  restart(): void {
    if (!this.readyExe) return
    log.info('reštart do novej verzie', { exe: this.readyExe })
    app.relaunch({ execPath: this.readyExe, args: [] })
    app.quit()
  }

  openPage(): void {
    if (this.state.pageUrl) void shell.openExternal(this.state.pageUrl)
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.controller?.abort()
  }
}
