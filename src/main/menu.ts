import { app, dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import sk from '../renderer/src/i18n/sk.json'
import en from '../renderer/src/i18n/en.json'
import type { UiLocale } from '../shared/ipc'

const DICT = { sk, en } as const
type Key = keyof typeof sk

export function systemUiLocale(): UiLocale {
  const base = app.getLocale().toLowerCase().split(/[-_]/)[0]
  return base === 'sk' || base === 'cs' ? 'sk' : 'en'
}

/** Preklad pre main proces (menu, oznámenia). */
export function translate(locale: UiLocale, k: Key, params?: Record<string, string | number>): string {
  const msg = DICT[locale][k] ?? sk[k]
  return params ? msg.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? '')) : msg
}

/** Postaví aplikačné menu v jazyku rozhrania. */
export function buildMenu(locale: UiLocale, getWindow: () => BrowserWindow | null, isDev: boolean): void {
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
          submenu: [
            { label: 'Slovenčina', type: 'radio', checked: locale === 'sk', click: () => send('locale:sk') },
            { label: 'English', type: 'radio', checked: locale === 'en', click: () => send('locale:en') }
          ]
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
        {
          label: t('menu.about'),
          click: () => {
            const win = getWindow()
            const opts = {
              type: 'info' as const,
              title: t('menu.about'),
              message: `${t('app.name')} ${app.getVersion()}`,
              detail: t('about.detail'),
              buttons: ['OK']
            }
            void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
