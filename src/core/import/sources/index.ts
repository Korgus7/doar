import { open, rename, rm, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { encodeMessage } from '../../export/mboxrd'
import { specialUseFor, type SourceFormat, type SourceInfo, type SourceMessage } from './common'
import { dbxInfo, readDbx } from './dbx'
import { emlInfo, readEml } from './eml'
import { pstInfo, readPst } from './pst'

export type { SourceFormat, SourceInfo } from './common'

/** Názov pôvodného programu – uloží sa do X-Doar-Source (informatívne). */
const SOURCE_NAME: Record<SourceFormat, string> = { eml: 'Windows Mail', dbx: 'Outlook Express', pst: 'Outlook' }

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Formát podľa vybranej cesty: priečinok (Outlook Express alebo Windows Mail) alebo súbor (.pst, .ost, .dbx, .eml).
 * Mbox sa sem nedostane (číta ho priamo obnova). Neznámy formát → null.
 */
export async function detectSource(path: string): Promise<SourceFormat | null> {
  const st = await stat(path).catch(() => null)
  if (!st) return null
  if (st.isDirectory()) {
    try {
      await dbxInfo(path)
      return 'dbx'
    } catch {
      /* nie je to Outlook Express */
    }
    const eml = await emlInfo(path)
    return eml.messages ? 'eml' : null
  }
  const ext = extname(path).toLowerCase()
  if (ext === '.pst' || ext === '.ost') return 'pst'
  if (ext === '.dbx') return 'dbx'
  if (ext === '.eml') return 'eml'
  return null
}

export async function sourceInfo(format: SourceFormat, path: string): Promise<SourceInfo> {
  if (format === 'pst') return pstInfo(path)
  if (format === 'dbx') return dbxInfo(path)
  return emlInfo(path)
}

function read(format: SourceFormat, path: string, opts: { signal?: AbortSignal; onSkip?: () => void }): AsyncGenerator<SourceMessage> {
  if (format === 'pst') return readPst(path, opts)
  if (format === 'dbx') return readDbx(path, opts)
  return readEml(path, opts)
}

/**
 * Prevedie poštu z iného programu do dočasného súboru vo formáte zálohy Doar (priečinky, príznaky, dátumy).
 * Zapisuje do `<cieľ>.part` a premenuje až po úspechu. Výsledok je pre rovnaký zdroj vždy rovnaký.
 */
export async function convertSource(
  format: SourceFormat,
  path: string,
  target: string,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<{ messages: number; skipped: number }> {
  const info = await sourceInfo(format, path)
  const part = `${target}.part`
  await rm(part, { force: true })
  const fh = await open(part, 'w')
  let messages = 0
  let skipped = 0
  let ok = false
  try {
    const onSkip = (): void => void skipped++
    for await (const m of read(format, path, { signal: opts.signal, onSkip })) {
      // Podpriečinky doručenej pošty (napr. „Doručená pošta / Projekty“) patria pod INBOX servera.
      const folder = m.folder.length > 1 && specialUseFor(m.folder.slice(0, 1)) === '\\Inbox' ? ['INBOX', ...m.folder.slice(1)] : m.folder
      const { chunk } = encodeMessage(m.raw, {
        source: SOURCE_NAME[format],
        folderSegments: folder,
        specialUse: specialUseFor(m.folder),
        internalDate: m.internalDate,
        flags: m.flags
      })
      await fh.write(chunk)
      messages++
      opts.onProgress?.(messages + skipped, Math.max(info.messages, messages + skipped))
    }
    if (opts.signal?.aborted) throw err('CANCELLED', 'Zrušené')
    await fh.sync()
    ok = true
  } finally {
    await fh.close()
    if (!ok) await rm(part, { force: true })
  }
  if (!messages) {
    await rm(part, { force: true })
    throw err('NO_MESSAGES', 'Nenašli sa žiadne správy')
  }
  await rename(part, target)
  return { messages, skipped }
}
