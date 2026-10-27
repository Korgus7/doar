import type { AttachmentInfo, FolderItem } from '../../../shared/ipc'
import { isArchiveId, isDangerousFile } from '../../../shared/ipc'
import { t, type MessageKey } from '../i18n/index.svelte'
import { mail, setSelection, indexOf, messageAt, itemsById, allIds, setFlags, loadFolders, findFolder, selectFolder } from './mail.svelte'

/**
 * Akcie nad správami (Kôš, Archív, presun, spam, natrvalo) a stav okolo nich:
 * kontextová ponuka, dialógy priečinkov a oznámenie s „Vrátiť späť“.
 *
 * Presun sa na server odošle až po krátkej dobe (jadro, `undoDelayMs`), dovtedy ho
 * „Vrátiť späť“ jednoducho zruší. Správy hneď zmiznú zo zoznamu.
 */

export type Special = 'trash' | 'archive' | 'junk' | 'inbox'
export interface MenuItem {
  label: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  run: () => void
}
export type MenuEntry = MenuItem | 'sep'

/** Ako dlho je vidieť „Vrátiť späť“. Kratšie než oneskorenie v jadre (8 s), aby tlačidlo nesľubovalo nemožné. */
const TOAST_MS = 7000

export const ui = $state({
  toast: null as null | { seq: number; text: string; undo: number[] | null; restore: number[]; tone: 'info' | 'error' },
  menu: null as null | { x: number; y: number; items: MenuEntry[]; label: string },
  /** Otvorený adresár. */
  contacts: false,
  moveDialog: null as null | { ids: number[]; accountId: number },
  /** Dialóg priečinka: nový (parentId = predvolené umiestnenie), alebo úprava existujúceho (editId). */
  newFolder: null as null | { accountId: number; parentId: number | null; editId?: number },
  /** Naposledy založený priečinok (dialóg presunu ho hneď vyberie). */
  createdFolderId: null as number | null,
  /** Práve ťahané správy (dragover nevidí obsah dataTransfer). */
  dragging: null as null | { ids: number[]; accountIds: number[] },
  /** Ťahaný priečinok (presun pod iný priečinok alebo na najvyššiu úroveň). */
  draggingFolder: null as null | { id: number; accountId: number }
})

let toastSeq = 0
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function showToast(text: string, opts: { undo?: number[]; restore?: number[]; tone?: 'info' | 'error' } = {}): void {
  if (toastTimer) clearTimeout(toastTimer)
  const seq = ++toastSeq
  ui.toast = { seq, text, undo: opts.undo?.length ? opts.undo : null, restore: opts.restore ?? [], tone: opts.tone ?? 'info' }
  toastTimer = setTimeout(() => {
    if (ui.toast?.seq === seq) ui.toast = null
  }, TOAST_MS)
}

export function hideToast(): void {
  if (toastTimer) clearTimeout(toastTimer)
  ui.toast = null
}

export function errorText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  const key = `errors.${code ?? 'UNKNOWN'}` as MessageKey
  if (t(key) !== key) return t(key)
  return t('errors.generic', { message: (e as { message?: string } | null)?.message ?? '' })
}

export function folderLabel(f: FolderItem): string {
  if (f.specialUse) return t(`folder.${f.specialUse}` as MessageKey)
  // Archív zo súboru bez priečinkov (cudzí mbox): jeden priečinok bez mena.
  return f.name || t('archive.messages')
}

export function folderById(id: number | null | undefined): FolderItem | undefined {
  return findFolder(id)
}

/** Správy kont (správy archívu sa nedajú meniť, presúvať ani mazať). */
function writable(ids: number[]): number[] {
  return ids.filter((id) => !isArchiveId(id))
}

function specialOf(ids: number[]): string | null | undefined {
  const uses = new Set(itemsById(ids).map((m) => folderById(m.folderId)?.specialUse ?? null))
  return uses.size === 1 ? [...uses][0] : undefined
}

/** Je správa koncept (v priečinku Koncepty)? */
export function isDraft(id: number): boolean {
  return !isArchiveId(id) && specialOf([id]) === 'drafts'
}

/** Sú všetky správy v Koši (Del potom maže natrvalo)? */
export function allInTrash(ids: number[]): boolean {
  return ids.length > 0 && specialOf(ids) === 'trash'
}
export function allInJunk(ids: number[]): boolean {
  return ids.length > 0 && specialOf(ids) === 'junk'
}
export function allInArchive(ids: number[]): boolean {
  const s = specialOf(ids)
  return ids.length > 0 && (s === 'archive' || s === 'all')
}

/** Jediné konto vybraných správ, inak null. */
export function singleAccount(ids: number[]): number | null {
  const accs = new Set(itemsById(ids).map((m) => m.accountId))
  return accs.size === 1 ? [...accs][0]! : null
}

/** Ktorú správu vybrať po presune: nasledujúcu za výberom, inak predchádzajúcu. */
function nextAfter(ids: number[]): number | null {
  const set = new Set(ids)
  const idx = ids.map(indexOf).filter((i) => i >= 0)
  if (!idx.length) return null
  const max = Math.max(...idx)
  const min = Math.min(...idx)
  for (let i = max + 1; i < mail.total; i++) {
    const m = messageAt(i)
    if (!m) break
    if (!set.has(m.id)) return m.id
  }
  for (let i = min - 1; i >= 0; i--) {
    const m = messageAt(i)
    if (m && !set.has(m.id)) return m.id
  }
  return null
}

function selectAfter(ids: number[]): void {
  const next = nextAfter(ids)
  setSelection(next === null ? [] : [next])
}

function targetLabel(target: { folderId?: number; special?: Special }): string {
  if (target.special) return t(`folder.${target.special}` as MessageKey)
  const f = folderById(target.folderId)
  return f ? folderLabel(f) : ''
}

export async function moveTo(list: number[], target: { folderId?: number; special?: Special }): Promise<void> {
  // Polia zo stavu Svelte sú proxy – cez MessagePort sa dajú poslať len obyčajné hodnoty.
  const ids = writable([...list])
  if (!ids.length) return
  const before = [...ids]
  try {
    selectAfter(ids)
    const r = await window.doar.invoke('messages.move', { ids, ...target })
    if (!r.count) {
      setSelection(before)
      return
    }
    const folder = targetLabel(target)
    const text = r.count === 1 ? t('actions.movedOne', { folder }) : t('actions.movedMany', { n: r.count, folder })
    showToast(text, { undo: r.undo, restore: before })
  } catch (e) {
    setSelection(before)
    showToast(errorText(e), { tone: 'error' })
  }
}

export async function undoLast(): Promise<void> {
  const toast = ui.toast
  if (!toast?.undo) return
  hideToast()
  try {
    const r = await window.doar.invoke('messages.undo', { undo: [...toast.undo] })
    if (r.undone) {
      setSelection([...toast.restore])
      showToast(t('actions.undone'))
    } else showToast(t('actions.tooLate'), { tone: 'error' })
  } catch (e) {
    showToast(errorText(e), { tone: 'error' })
  }
}

/** Del: do Koša; v Koši natrvalo (s potvrdením). */
export function remove(list: number[]): void {
  const ids = writable(list)
  if (!ids.length) return
  if (allInTrash(ids)) void removeForever(ids)
  else void moveTo(ids, { special: 'trash' })
}

/** Shift+Del: natrvalo, vždy s potvrdením. */
export async function removeForever(list: number[]): Promise<void> {
  const ids = writable([...list])
  if (!ids.length) return
  const q = ids.length === 1 ? t('actions.confirmForeverOne') : t('actions.confirmForeverMany', { n: ids.length })
  if (!confirm(q)) return
  try {
    selectAfter(ids)
    await window.doar.invoke('messages.deleteForever', { ids })
    showToast(ids.length === 1 ? t('actions.deletedOne') : t('actions.deletedMany', { n: ids.length }))
  } catch (e) {
    setSelection(ids)
    showToast(errorText(e), { tone: 'error' })
  }
}

export function archive(list: number[]): void {
  const ids = writable(list)
  if (ids.length && !allInArchive(ids)) void moveTo(ids, { special: 'archive' })
}

export function toggleSpam(list: number[]): void {
  const ids = writable(list)
  if (!ids.length) return
  void moveTo(ids, { special: allInJunk(ids) ? 'inbox' : 'junk' })
}

export function openMoveDialog(list: number[]): void {
  const ids = writable(list)
  if (!ids.length) return
  const accountId = singleAccount(ids)
  if (accountId === null) {
    showToast(t('errors.CROSS_ACCOUNT'), { tone: 'error' })
    return
  }
  ui.createdFolderId = null
  ui.moveDialog = { ids, accountId }
}

export async function selectAll(): Promise<void> {
  const ids = await allIds()
  setSelection(ids, mail.cursor ?? ids[0] ?? null)
}

export async function createFolder(accountId: number, parentId: number | null, name: string): Promise<number> {
  const r = await window.doar.invoke('folders.create', { accountId, parentId, name })
  await loadFolders()
  ui.createdFolderId = r.folderId
  showToast(t('folderDialog.created', { name: name.trim() }))
  return r.folderId
}

/** Premenuje priečinok a/alebo ho presunie pod iný (parentId null = najvyššia úroveň). */
export async function renameFolder(folderId: number, name: string, parentId: number | null): Promise<void> {
  await window.doar.invoke('folders.rename', { folderId, name, parentId })
  await loadFolders()
  showToast(t('folderDialog.renamed', { name: name.trim() }))
}

/** Priečinky pod daným priečinkom (všetky úrovne). */
export function descendantIds(f: FolderItem): Set<number> {
  const own = mail.folders.filter((x) => x.accountId === f.accountId)
  const byPath = new Map(own.map((x) => [x.path, x]))
  const out = new Set<number>()
  for (const x of own) {
    for (let p = x.parentPath, i = 0; p !== null && i < 64; p = byPath.get(p)?.parentPath ?? null, i++) {
      if (p === f.path) {
        out.add(x.id)
        break
      }
    }
  }
  return out
}

/** Odstráni priečinok aj s podpriečinkami po potvrdení (správy idú do Koša; Gmail: len štítok). */
export async function deleteFolder(f: FolderItem): Promise<void> {
  const own = mail.folders.filter((x) => x.accountId === f.accountId)
  const below = descendantIds(f)
  const sub = own.filter((x) => x.id === f.id || below.has(x.id))
  const n = sub.reduce((s, x) => s + Math.max(x.total, x.localCount), 0)
  const gmail = own.some((x) => /^\[(Gmail|Google Mail)\]/.test(x.path))
  const name = folderLabel(f)
  if (!confirm(gmail ? t('folders.deleteConfirmGmail', { name }) : t('folders.deleteConfirm', { name, n }))) return
  try {
    const r = await window.doar.invoke('folders.delete', { folderId: f.id })
    await loadFolders()
    if (mail.folderId !== null && !isArchiveId(mail.folderId) && !mail.folders.some((x) => x.id === mail.folderId)) await selectFolder(null)
    showToast(r.moved ? t('folders.deletedMoved', { name, n: r.moved }) : t('folders.deleted', { name }))
  } catch (e) {
    await loadFolders().catch(() => {})
    showToast(errorText(e), { tone: 'error' })
  }
}

/** Položky kontextovej ponuky pre vybrané správy. */
export function messageMenu(ids: number[]): MenuEntry[] {
  const items = itemsById(ids)
  const one = ids.length === 1 ? ids[0]! : null
  const anyUnread = items.some((m) => !m.seen)
  const anyUnflagged = items.some((m) => !m.flagged)
  const inTrash = allInTrash(ids)
  const entries: MenuEntry[] = []
  if (one !== null && isDraft(one)) {
    entries.push({ label: t('reader.editDraft'), shortcut: 'Enter', run: () => window.doar.openCompose('draft', one) }, 'sep')
  } else if (one !== null) {
    entries.push(
      { label: t('toolbar.reply'), shortcut: 'Ctrl+R', run: () => window.doar.openCompose('reply', one) },
      { label: t('toolbar.replyAll'), shortcut: 'Ctrl+Shift+R', run: () => window.doar.openCompose('replyAll', one) },
      { label: t('toolbar.forward'), shortcut: 'Ctrl+F', run: () => window.doar.openCompose('forward', one) },
      { label: t('reader.print'), shortcut: 'Ctrl+P', run: () => window.dispatchEvent(new Event('doar-print')) },
      'sep'
    )
  }
  // Archív je len na čítanie: odpovedať, preposlať, vytlačiť.
  if (!writable(ids).length) {
    if (entries.at(-1) === 'sep') entries.pop()
    return entries
  }
  entries.push(
    { label: anyUnread ? t('reader.markRead') : t('reader.markUnread'), run: () => void setFlags(ids, { seen: anyUnread }) },
    { label: anyUnflagged ? t('reader.flag') : t('reader.unflag'), run: () => void setFlags(ids, { flagged: anyUnflagged }) },
    'sep',
    { label: t('actions.archive'), shortcut: 'E', disabled: allInArchive(ids), run: () => archive(ids) },
    { label: t('actions.moveTo'), shortcut: 'Ctrl+Shift+V', disabled: singleAccount(ids) === null, run: () => openMoveDialog(ids) },
    { label: allInJunk(ids) ? t('actions.notSpam') : t('actions.spam'), run: () => toggleSpam(ids) },
    'sep',
    { label: inTrash ? t('actions.deleteForever') : t('actions.delete'), shortcut: 'Del', danger: inTrash, run: () => remove(ids) }
  )
  if (!inTrash) entries.push({ label: t('actions.deleteForever'), shortcut: 'Shift+Del', danger: true, run: () => void removeForever(ids) })
  return entries
}

export function openMenu(x: number, y: number, items: MenuEntry[], label: string): void {
  ui.menu = { x, y, items, label }
}

/* ---------- Prílohy ---------- */

export async function saveAttachment(messageId: number, a: AttachmentInfo): Promise<void> {
  try {
    const path = await window.doar.chooseSavePath(a.filename)
    if (!path) return
    await window.doar.invoke('attachments.save', { messageId, index: a.index, path })
    showToast(t('attachments.saved', { name: path.split(/[\\/]/).pop() ?? a.filename }))
  } catch (e) {
    showToast(errorText(e), { tone: 'error' })
  }
}

export async function saveAllAttachments(messageId: number): Promise<void> {
  try {
    const dir = await window.doar.chooseFolder()
    if (!dir) return
    const { saved } = await window.doar.invoke('attachments.saveAll', { messageId, dir })
    showToast(t('attachments.savedAll', { n: saved.length, folder: dir }))
  } catch (e) {
    showToast(errorText(e), { tone: 'error' })
  }
}

export async function openAttachment(messageId: number, a: AttachmentInfo): Promise<void> {
  if (isDangerousFile(a.filename)) {
    showToast(t('errors.DANGEROUS_ATTACHMENT'), { tone: 'error' })
    return
  }
  try {
    const { path } = await window.doar.invoke('attachments.prepareOpen', { messageId, index: a.index })
    if (!(await window.doar.openAttachmentFile(path))) showToast(t('attachments.noApp', { name: a.filename }), { tone: 'error' })
  } catch (e) {
    showToast(errorText(e), { tone: 'error' })
  }
}

export function attachmentMenu(messageId: number, a: AttachmentInfo): MenuEntry[] {
  const dangerous = isDangerousFile(a.filename)
  return [
    { label: dangerous ? t('attachments.openBlocked') : t('attachments.open'), disabled: dangerous, run: () => void openAttachment(messageId, a) },
    { label: t('attachments.saveAs'), run: () => void saveAttachment(messageId, a) }
  ]
}
