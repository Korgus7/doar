import { app, dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
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
export function showAbout(win: BrowserWindow | null): void {
  const t = (k: Key): string => translate(currentLocale, k)
  const opts = {
    type: 'info' as const,
    title: t('menu.about'),
    message: `${t('app.name')} ${app.getVersion()}`,
    detail: t('about.detail'),
    buttons: ['OK']
  }
  void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
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
