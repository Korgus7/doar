import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { headerDate, looksLikeMessage, yieldNow, type SourceInfo, type SourceMessage } from './common'

/**
 * Windows Mail (Vista) a Windows Live Mail: každá správa je súbor .eml, priečinky sú obyčajné priečinky.
 * Stav „prečítané“ si tieto programy držia v osobitnej databáze, ktorú nečítame – správy sa preto
 * importujú ako prečítané (staršia pošta), aby sa doručená pošta nezaplavila tisíckami „nových“ správ.
 */

const MAX_DEPTH = 12
const MAX_MESSAGE = 100 * 1024 * 1024

interface EmlFile {
  path: string
  folder: string[]
}

/** Všetky súbory .eml pod priečinkom (zoradené, aby bol výsledok vždy rovnaký). */
async function listEml(root: string): Promise<EmlFile[]> {
  const out: EmlFile[] = []
  const walk = async (dir: string, folder: string[]): Promise<void> => {
    if (folder.length > MAX_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (e.isFile() && /\.eml$/i.test(e.name)) out.push({ path: join(dir, e.name), folder })
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(join(dir, e.name), [...folder, e.name])
    }
  }
  await walk(root, [])
  return out
}

/**
 * Zvolený priečinok: jeho podpriečinky sú priečinky pošty (Doručená pošta, Odoslaná pošta…).
 * Ak .eml ležia priamo v ňom, patria do priečinka s jeho názvom.
 */
function mapFolder(root: string, folder: string[]): string[] {
  return folder.length ? folder : [basename(root)]
}

export async function emlInfo(path: string): Promise<SourceInfo> {
  const st = await stat(path)
  if (st.isFile()) return { format: 'eml', messages: 1, folders: 0 }
  const files = await listEml(path)
  return { format: 'eml', messages: files.length, folders: new Set(files.map((f) => mapFolder(path, f.folder).join('/'))).size }
}

export async function* readEml(path: string, opts: { signal?: AbortSignal; onSkip?: () => void } = {}): AsyncGenerator<SourceMessage> {
  const st = await stat(path)
  const files: EmlFile[] = st.isFile() ? [{ path, folder: [] }] : await listEml(path)
  for (const f of files) {
    if (opts.signal?.aborted) return
    let raw: Buffer
    let mtime: Date
    try {
      const s = await stat(f.path)
      if (s.size > MAX_MESSAGE || s.size === 0) throw new Error('size')
      raw = await readFile(f.path)
      mtime = s.mtime
    } catch {
      opts.onSkip?.()
      continue
    }
    if (!looksLikeMessage(raw)) {
      opts.onSkip?.()
      continue
    }
    yield {
      raw,
      folder: st.isFile() ? [] : mapFolder(path, f.folder),
      flags: new Set(['\\Seen']),
      internalDate: headerDate(raw) ?? mtime
    }
    await yieldNow()
  }
}
