import type { LocalFolderMeta, MailStore } from '../store/mailstore'
import type { SpecialUse } from '../../shared/ipc'

/**
 * Zmeny priečinkov bez servera: konto „len v počítači“ a zmeny bez pripojenia (na server pôjdu neskôr).
 * Kontroly sú rovnaké ako pri zmene na serveri.
 */

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Priečinok a všetky jeho podpriečinky. */
export function folderSubtree(store: MailStore, accountId: number, path: string): LocalFolderMeta[] {
  const rows = store.folderMeta(accountId)
  const target = rows.find((r) => r.path === path)
  if (!target) return []
  const d = target.delimiter || store.folderDelimiter(accountId)
  return rows.filter((r) => r.path === path || r.path.startsWith(`${path}${d}`))
}

function isProtected(rows: LocalFolderMeta[]): boolean {
  return rows.some((r) => r.path.toUpperCase() === 'INBOX' || !!r.special_use)
}

/** Nový priečinok len lokálne. Vráti ID a cestu. */
export function createLocalFolder(store: MailStore, accountId: number, parentPath: string | null, name: string, specialUse: SpecialUse | null = null): { id: number; path: string } {
  const delimiter = store.folderDelimiter(accountId)
  if (name.includes(delimiter)) throw fail('INVALID_FOLDER_NAME', 'Názov obsahuje oddeľovač priečinkov')
  const rows = store.folderMeta(accountId)
  if (parentPath !== null && !rows.some((r) => r.path === parentPath && !r.hidden)) throw fail('NO_TARGET', 'Nadradený priečinok neexistuje')
  const path = parentPath ? `${parentPath}${delimiter}${name}` : `${store.topLevelPrefix(accountId)}${name}`
  if (rows.some((r) => r.path.toLowerCase() === path.toLowerCase())) throw fail('FOLDER_EXISTS', 'Priečinok už existuje')
  const parent = parentPath ?? (path.includes(delimiter) ? path.slice(0, path.lastIndexOf(delimiter)) : null)
  const id = store.addLocalFolder(accountId, { path, delimiter, name, parentPath: parent, specialUse })
  return { id, path }
}

export interface LocalRename {
  oldPath: string
  newPath: string
  delimiter: string
  parentPath: string | null
  name: string
  /** Pôvodné umiestnenie – na vrátenie, ak server zmenu odmietne. */
  oldParentPath: string | null
  oldName: string
}

/** Premenovanie alebo presun priečinka (aj s podpriečinkami) len lokálne. null = nič sa nemení. */
export function renameLocalFolder(store: MailStore, accountId: number, oldPath: string, parentPath: string | null, name: string): LocalRename | null {
  const rows = store.folderMeta(accountId)
  const target = rows.find((r) => r.path === oldPath && !r.hidden)
  if (!target) throw fail('NO_TARGET', 'Priečinok neexistuje')
  const delimiter = target.delimiter || store.folderDelimiter(accountId)
  if (name.includes(delimiter)) throw fail('INVALID_FOLDER_NAME', 'Názov obsahuje oddeľovač priečinkov')
  if (isProtected(folderSubtree(store, accountId, oldPath))) throw fail('FOLDER_PROTECTED', 'Tento priečinok sa nedá premenovať')
  if (parentPath !== null && (parentPath === oldPath || parentPath.startsWith(`${oldPath}${delimiter}`))) {
    throw fail('FOLDER_INTO_ITSELF', 'Priečinok sa nedá presunúť do seba')
  }
  if (parentPath !== null && !rows.some((r) => r.path === parentPath && !r.hidden)) throw fail('NO_TARGET', 'Nadradený priečinok neexistuje')
  const newPath = parentPath ? `${parentPath}${delimiter}${name}` : `${store.topLevelPrefix(accountId)}${name}`
  if (newPath === oldPath) return null
  if (rows.some((r) => r.path !== oldPath && r.path.toLowerCase() === newPath.toLowerCase())) throw fail('FOLDER_EXISTS', 'Priečinok už existuje')
  const newParent = parentPath ?? (newPath.includes(delimiter) ? newPath.slice(0, newPath.lastIndexOf(delimiter)) : null)
  store.renameFolderTree(accountId, oldPath, newPath, delimiter, newParent, name)
  return { oldPath, newPath, delimiter, parentPath: newParent, name, oldParentPath: target.parent_path, oldName: target.name }
}

/** Vráti lokálne premenovanie späť (server ho odmietol). */
export function undoLocalRename(store: MailStore, accountId: number, r: LocalRename): void {
  if (!store.folderMeta(accountId).some((f) => f.path === r.newPath)) return
  store.renameFolderTree(accountId, r.newPath, r.oldPath, r.delimiter, r.oldParentPath, r.oldName)
}

/** Kontrola pred odstránením priečinka (Doručená pošta a špeciálne priečinky sa odstrániť nedajú). */
export function deletableSubtree(store: MailStore, accountId: number, path: string): LocalFolderMeta[] {
  const rows = folderSubtree(store, accountId, path).filter((r) => !r.hidden)
  if (!rows.length) throw fail('NO_TARGET', 'Priečinok neexistuje')
  if (isProtected(rows)) throw fail('FOLDER_PROTECTED', 'Tento priečinok sa odstrániť nedá')
  return rows
}
