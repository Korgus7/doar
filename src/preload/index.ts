import { contextBridge, ipcRenderer } from 'electron'
import type { DoarApi, EventChannel, PortMessage, RequestChannel } from '../shared/ipc'

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
  openCompose(mode, messageId) {
    ipcRenderer.send('open-compose', mode, messageId)
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
