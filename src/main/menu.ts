import { app, BrowserWindow, dialog, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sk from '../renderer/src/i18n/sk.json'
import en from '../renderer/src/i18n/en.json'
import cs from '../renderer/src/i18n/cs.json'
import de from '../renderer/src/i18n/de.json'
import hu from '../renderer/src/i18n/hu.json'
import fr from '../renderer/src/i18n/fr.json'
import es from '../renderer/src/i18n/es.json'
import ru from '../renderer/src/i18n/ru.json'
import he from '../renderer/src/i18n/he.json'
import { LOCALE_NAMES, UI_LOCALES, pickUiLocale, type UiLocale } from '../shared/ipc'

const DICT: Record<UiLocale, Record<Key, string>> = { sk, en, cs, de, hu, fr, es, ru, he }
type Key = keyof typeof sk

export function systemUiLocale(): UiLocale {
  return pickUiLocale(app.getLocale())
}

/** Preklad pre main proces (menu, oznámenia). */
export function translate(locale: UiLocale, k: Key, params?: Record<string, string | number>): string {
  const msg = DICT[locale][k] ?? sk[k]
  return params ? msg.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? '')) : msg
}

let currentLocale: UiLocale = 'sk'

/** Okno „O programe“ (z menu Pomocník aj z ponuky ☰ v rozhraní). */
/** Webová stránka Doaru (stiahnutie, návod, ochrana súkromia) a zdrojový kód. */
export const WEBSITE = 'https://cami.sk/doar'
export const GITHUB = 'https://github.com/Korgus7/doar'
/** Dobrovoľná podpora: PayPal a QR platba (payme.sk – otvorí bankovú aplikáciu). */
export const PAYPAL = 'https://paypal.me/korgus'
/** Odkaz z QR kódu (payme.sk – rovnaký ako v obrázku), aby sa dalo zaplatiť aj kliknutím. */
export const PAYME = 'https://payme.sk/2/q/PME?IBAN=SK0209000000000653071770&CN=%C4%8Caputa+Milan'
const SUPPORT_LINKS = [PAYPAL, PAYME]

let supportWin: BrowserWindow | null = null

/** Okno „Podporiť Doar“: QR kód na platbu a tlačidlo PayPal. Odkazy sa otvoria v prehliadači. */
export function showSupport(parent: BrowserWindow | null): void {
  if (supportWin && !supportWin.isDestroyed()) {
    supportWin.focus()
    return
  }
  const t = (k: Key): string => translate(currentLocale, k)
  const esc = (x: string): string => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  let qr = ''
  try {
    qr = `data:image/png;base64,${readFileSync(join(app.getAppPath(), 'resources', 'podpora-qr.png')).toString('base64')}`
  } catch {
    // bez QR kódu ostane len PayPal
  }
  const dark = nativeTheme.shouldUseDarkColors
  const html = `<!doctype html><html lang="${currentLocale}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(t('support.title'))}</title><style>
body{margin:0;padding:22px 26px;font:14px/1.5 'Segoe UI',system-ui,sans-serif;background:${dark ? '#1d232c' : '#f6f5f2'};color:${dark ? '#e6e8eb' : '#1f2328'};text-align:center}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 14px}
img{width:200px;height:auto;background:#fff;padding:8px;border:1px solid #c9d1dc;border-radius:3px}
.small{font-size:12px;opacity:.75;margin:6px 0 18px}
a.btn{display:inline-block;padding:8px 18px;border-radius:3px;background:#2d4362;color:#fff;text-decoration:none;font-weight:600}
a.btn:hover{background:#3a5680}
</style></head><body>
<h1>${esc(t('support.title'))}</h1>
<p>${esc(t('support.text'))}</p>
${qr ? `<a href="${PAYME}" title="payme.sk"><img src="${qr}" alt="${esc(t('support.qr'))}"></a><p class="small">${esc(t('support.qr'))}</p>` : ''}
<a class="btn" href="${PAYPAL}">${esc(t('support.paypal'))}</a>
<p class="small">${esc(t('support.thanks'))}</p>
</body></html>`
  const w = new BrowserWindow({
    width: 440,
    height: qr ? 640 : 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    parent: parent ?? undefined,
    title: t('support.title'),
    backgroundColor: dark ? '#1d232c' : '#f6f5f2',
    // Skripty stránka nemá a CSP ich zakazuje (default-src 'none').
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  supportWin = w
  w.setMenu(null)
  // Odkazy (PayPal, payme.sk) len do systémového prehliadača; inam sa nenaviguje.
  const open = (url: string): void => {
    if (SUPPORT_LINKS.some((l) => url.startsWith(l))) void shell.openExternal(url)
  }
  w.webContents.setWindowOpenHandler(({ url }) => {
    open(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    open(url)
  })
  w.on('closed', () => {
    if (supportWin === w) supportWin = null
  })
  void w.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`)
}


export function showAbout(win: BrowserWindow | null): void {
  const t = (k: Key): string => translate(currentLocale, k)
  const opts = {
    type: 'info' as const,
    title: t('menu.about'),
    message: `${t('app.name')} ${app.getVersion()}`,
    detail: `${t('about.detail')}\n\n${WEBSITE}\n${GITHUB}`,
    buttons: ['OK', t('about.website'), 'GitHub', t('about.support')],
    defaultId: 0,
    cancelId: 0
  }
  void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then((r) => {
    if (r.response === 1) void shell.openExternal(WEBSITE)
    else if (r.response === 2) void shell.openExternal(GITHUB)
    else if (r.response === 3) showSupport(win)
  })
}

/** Postaví aplikačné menu v jazyku rozhrania. */
export function buildMenu(locale: UiLocale, getWindow: () => BrowserWindow | null, isDev: boolean): void {
  currentLocale = locale
  const t = (k: Key): string => translate(locale, k)
  const send = (action: string): void => getWindow()?.webContents.send('menu-action', action)
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.addAccount'), click: () => send('add-account') },
        { label: t('menu.backup'), click: () => send('backup') },
        { label: t('menu.restore'), click: () => send('restore') },
        { label: t('menu.openArchive'), click: () => send('open-archive') },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        isMac ? { role: 'close', label: t('menu.close') } : { role: 'quit', label: t('menu.quit') }
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') }
      ]
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { role: 'resetZoom', label: t('menu.zoomReset') },
        { type: 'separator' },
        {
          // Dvojjazyčný názov – nájde ho aj ten, kto jazyku rozhrania nerozumie.
          label: 'Jazyk / Language',
          submenu: UI_LOCALES.map((l) => ({ label: LOCALE_NAMES[l], type: 'radio' as const, checked: locale === l, click: () => send(`locale:${l}`) }))
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
        ...(isDev ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : [])
      ]
    },
    {
      label: t('menu.help'),
      submenu: [
        { label: t('menu.checkUpdates'), click: () => send('check-updates') },
        { type: 'separator' },
        { label: t('menu.about'), click: () => showAbout(getWindow()) }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
