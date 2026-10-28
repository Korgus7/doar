import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DoarApi, EventChannel, PortMessage, RequestChannel, UpdateState } from '../shared/ipc'

/**
 * Jediný most medzi rozhraním a zvyškom aplikácie.
 * Rozhranie dostane len invoke/on – žiadny Node.js, žiadny ipcRenderer.
 */

let port: MessagePort | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const queue: PortMessage[] = []
const listeners = new Map<string, Set<(data: unknown) => void>>()

function send(msg: PortMessage): void {
  if (port) port.postMessage(msg)
  else queue.push(msg)
}

ipcRenderer.on('core-port', (event) => {
  const p = event.ports[0]
  if (!p) return
  // Pri reštarte jadra prídu nový port; staré nevybavené požiadavky zlyhajú.
  if (port) {
    port.close()
    for (const [, w] of pending) w.reject({ code: 'CORE_RESTARTED', message: 'Jadro aplikácie sa reštartovalo' })
    pending.clear()
  }
  port = p
  port.onmessage = (e: MessageEvent<PortMessage>) => {
    const msg = e.data
    if (msg.kind === 'res') {
      const w = pending.get(msg.id)
      if (!w) return
      pending.delete(msg.id)
      if (msg.ok) w.resolve(msg.data)
      // contextBridge z objektu Error prenesie len text – kód chyby by sa stratil.
      // Preto odmietame obyčajným objektom { code, message }, ktorý prejde celý.
      else w.reject({ code: msg.error.code, message: msg.error.message })
    } else if (msg.kind === 'evt') {
      listeners.get(msg.ch)?.forEach((fn) => fn(msg.data))
    }
  }
  port.start()
  while (queue.length) port.postMessage(queue.shift())
})

const localeArg = process.argv.find((a) => a.startsWith('--doar-locale='))

const api: DoarApi = {
  invoke(ch: RequestChannel, data?: unknown) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      send({ kind: 'req', id, ch, data })
    })
  },
  on(ch: EventChannel, fn: (data: never) => void) {
    const set = listeners.get(ch) ?? new Set()
    set.add(fn as (data: unknown) => void)
    listeners.set(ch, set)
    return () => set.delete(fn as (data: unknown) => void)
  },
  locale: localeArg ? localeArg.slice('--doar-locale='.length) : 'sk',
  setUiLocale(locale) {
    ipcRenderer.send('ui-locale', locale)
  },
  setTheme(theme) {
    ipcRenderer.send('ui-theme', theme)
  },
  showAbout() {
    ipcRenderer.send('show-about')
  },
  openCompose(mode, messageId, to) {
    ipcRenderer.send('open-compose', mode, messageId, to)
  },
  openMessage(id) {
    if (Number.isInteger(id)) ipcRenderer.send('open-message', id)
  },
  previewPdf(path, title) {
    return ipcRenderer.invoke('preview-pdf', path, title) as Promise<boolean>
  },
  savePdf(html, title) {
    return ipcRenderer.invoke('save-pdf', html, title) as Promise<boolean>
  },
  closeWindow() {
    ipcRenderer.send('close-window')
  },
  onCloseRequest(fn) {
    const h = (): void => fn()
    ipcRenderer.on('close-request', h)
    return () => ipcRenderer.removeListener('close-request', h)
  },
  chooseExportFile(defaultName) {
    return ipcRenderer.invoke('choose-export-file', defaultName) as Promise<string | null>
  },
  chooseImportFile() {
    return ipcRenderer.invoke('choose-import-file') as Promise<string | null>
  },
  chooseImportFolder() {
    return ipcRenderer.invoke('choose-import-folder') as Promise<string | null>
  },
  recreateShortcuts() {
    return ipcRenderer.invoke('recreate-shortcuts') as Promise<boolean>
  },
  copyText(text) {
    if (typeof text === 'string') ipcRenderer.send('copy-text', text)
  },
  chooseContactsFiles() {
    return ipcRenderer.invoke('choose-contacts-files') as Promise<string[]>
  },
  chooseAttachFiles() {
    return ipcRenderer.invoke('choose-attach-files')
  },
  filesFromDrop(files) {
    // Cestu k súboru vie zistiť len preload a len zo skutočného súboru pretiahnutého používateľom.
    const paths = Array.from(files ?? [])
      .map((f) => {
        try {
          return webUtils.getPathForFile(f)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    return paths.length ? ipcRenderer.invoke('dropped-files', paths) : Promise.resolve([])
  },
  chooseSavePath(defaultName) {
    return ipcRenderer.invoke('choose-save-path', defaultName) as Promise<string | null>
  },
  chooseFolder() {
    return ipcRenderer.invoke('choose-folder') as Promise<string | null>
  },
  printHtml(html, title) {
    if (typeof html === 'string') ipcRenderer.send('print-html', html, typeof title === 'string' ? title : '')
  },
  setUnreadCount(n) {
    if (Number.isInteger(n)) ipcRenderer.send('unread-count', n)
  },
  updateState() {
    return ipcRenderer.invoke('update-state') as Promise<UpdateState>
  },
  updateCheck() {
    ipcRenderer.send('update-cmd', 'check')
  },
  updateDownload() {
    ipcRenderer.send('update-cmd', 'download')
  },
  updateCancel() {
    ipcRenderer.send('update-cmd', 'cancel')
  },
  updateRestart() {
    ipcRenderer.send('update-cmd', 'restart')
  },
  updateSetAuto(on) {
    ipcRenderer.send('update-cmd', on ? 'auto-on' : 'auto-off')
  },
  updateOpenPage() {
    ipcRenderer.send('update-cmd', 'open-page')
  },
  onUpdateState(fn) {
    const h = (_e: unknown, s: UpdateState): void => fn(s)
    ipcRenderer.on('update-state', h)
    return () => ipcRenderer.removeListener('update-state', h)
  },
  claimDraft(draftId) {
    return ipcRenderer.invoke('claim-draft', draftId) as Promise<boolean>
  },
  openAttachmentFile(path) {
    return ipcRenderer.invoke('open-attachment-file', path) as Promise<boolean>
  },
  showInFolder(path) {
    if (typeof path === 'string') ipcRenderer.send('show-in-folder', path)
  },
  openExternal(url) {
    if (typeof url === 'string') ipcRenderer.send('open-external', url)
  },
  onMenuAction(fn) {
    const h = (_e: unknown, action: unknown): void => {
      if (typeof action === 'string') fn(action)
    }
    ipcRenderer.on('menu-action', h)
    return () => ipcRenderer.removeListener('menu-action', h)
  }
} as DoarApi

contextBridge.exposeInMainWorld('doar', api)
