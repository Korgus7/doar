import type { ArchiveSummary } from '../../../shared/ipc'
import { t } from '../i18n/index.svelte'
import { mail, loadArchives, selectFolder } from './mail.svelte'
import { errorText, showToast } from './actions.svelte'

/**
 * Lokálny archív v rozhraní: otvorenie súboru mbox (len na čítanie), zatvorenie, priebeh načítania.
 * Priečinky archívu sa zobrazia v ľavom paneli pod kontami a otvárajú sa ako bežné priečinky.
 */

/** Archív, ktorý používateľ práve otvoril – po načítaní sa zobrazí jeho prvý priečinok. */
let pendingOpen: number | null = null

export async function openArchive(): Promise<void> {
  try {
    const path = await window.doar.chooseImportFile()
    if (!path) return
    if (/\.eml$/i.test(path)) return await openEmlFile(path)
    const { archiveId } = await window.doar.invoke('archives.open', { path })
    pendingOpen = archiveId
    await afterChange()
  } catch (e) {
    showToast(errorText(e), { tone: 'error' })
  }
}

/** Súbor .eml (vybraný alebo pretiahnutý do okna) – otvorí sa v samostatnom okne, len na čítanie. */
export async function openEmlFile(path: string): Promise<void> {
  try {
    const { id } = await window.doar.invoke('archives.openEml', { path })
    window.doar.openMessage(id)
  } catch (e) {
    showToast(errorText(e), { tone: 'error' })
  }
}

/** Súbory pretiahnuté z Prieskumníka do hlavného okna: .eml sa otvoria, archívy mbox sa pridajú. */
export async function openDroppedFiles(files: File[]): Promise<void> {
  const picked = await window.doar.filesFromDrop(files)
  for (const f of picked.slice(0, 20)) {
    if (/\.eml$/i.test(f.name)) await openEmlFile(f.path)
    else if (/\.(mbox|mbx)$/i.test(f.name)) {
      try {
        const { archiveId } = await window.doar.invoke('archives.open', { path: f.path })
        pendingOpen = archiveId
        await afterChange()
      } catch (e) {
        showToast(errorText(e), { tone: 'error' })
      }
    }
  }
}

export async function closeArchive(a: ArchiveSummary): Promise<void> {
  if (!confirm(t('archive.closeConfirm', { name: a.name }))) return
  try {
    await window.doar.invoke('archives.close', { archiveId: a.id })
    await loadArchives()
  } catch (e) {
    showToast(errorText(e), { tone: 'error' })
  }
}

async function afterChange(): Promise<void> {
  await loadArchives()
  if (pendingOpen === null) return
  const a = mail.archives.find((x) => x.id === pendingOpen)
  if (!a || a.state === 'failed') {
    pendingOpen = null
    if (a?.error) showToast(errorText({ code: a.error }), { tone: 'error' })
    return
  }
  const first = mail.archiveFolders.find((f) => f.accountId === -a.id)
  if (a.state === 'ready' && first) {
    pendingOpen = null
    await selectFolder(first.id)
  }
}

/** Percento načítania archívu (pre ľavý panel a stavový riadok). */
export function archivePercent(a: ArchiveSummary): number {
  const p = a.progress
  return p && p.fileSize ? Math.min(99, Math.floor((p.bytesRead / p.fileSize) * 100)) : 0
}

export function initArchiveEvents(): () => void {
  void loadArchives().catch(() => {})
  const offs = [
    window.doar.on('archives.changed', () => void afterChange().catch(() => {})),
    window.doar.on('archives.progress', (p) => {
      const a = mail.archives.find((x) => x.id === p.archiveId)
      if (a) a.progress = { bytesRead: p.bytesRead, fileSize: p.fileSize, messages: p.messages }
    })
  ]
  return () => offs.forEach((o) => o())
}
