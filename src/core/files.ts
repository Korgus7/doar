import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve, extname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OPEN_ATTACHMENTS_DIR } from '../shared/ipc'

export type GrantMode = 'read' | 'write' | 'dir'

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Súbory a priečinky, s ktorými jadro smie pracovať. Rozhranie nikdy nezadáva cestu samo –
 * cestu zvolí používateľ v natívnom dialógu (alebo súbor pretiahne myšou) a main proces ju sem oznámi.
 */
export class FileGrants {
  private grants = new Map<string, Set<GrantMode>>()

  allow(path: string, mode: GrantMode): void {
    if (typeof path !== 'string' || !path || path.length > 4096) return
    const key = resolve(path)
    const set = this.grants.get(key) ?? new Set()
    set.add(mode)
    this.grants.set(key, set)
  }

  has(path: string, mode: GrantMode): boolean {
    return typeof path === 'string' && !!path && !!this.grants.get(resolve(path))?.has(mode)
  }

  /** Povolenie prichádza od main procesu iným kanálom než požiadavka z rozhrania – chvíľu naň počkáme. */
  async require(path: string, mode: GrantMode): Promise<string> {
    for (let i = 0; i < 20 && !this.has(path, mode); i++) await new Promise((r) => setTimeout(r, 50))
    if (!this.has(path, mode)) throw err('PATH_NOT_ALLOWED', 'Súbor treba vybrať v dialógu')
    return resolve(path)
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/** Bezpečný názov súboru pre Windows, macOS aj Linux (bez ciest, zakázaných znakov a rezervovaných mien). */
export function safeFilename(name: string, fallback = 'priloha'): string {
  let n = (name ?? '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (!n) n = fallback
  const ext = extname(n)
  const stem = n.slice(0, n.length - ext.length)
  if (RESERVED.test(stem)) n = `_${n}`
  // Rozumná dĺžka (väčšina súborových systémov 255 bajtov).
  while (Buffer.byteLength(n) > 200) {
    const e = extname(n)
    const s = n.slice(0, n.length - e.length)
    n = s.slice(0, Math.max(1, s.length - 10)) + e
  }
  return n
}

/** „faktura.pdf“ → „faktura (2).pdf“, ak už existuje (alebo je už použitý v tej istej dávke). */
export function uniqueName(dir: string, name: string, used: Set<string> = new Set()): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let i = 2; existsSync(join(dir, candidate)) || used.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`
  used.add(candidate.toLowerCase())
  return candidate
}

/**
 * Zapíše súbor bezpečne: najprv dočasný súbor, potom premenovanie (žiadny polovičný súbor).
 * Na Windows pridá značku „stiahnuté z internetu“ (Mark of the Web), aby systém pred otvorením varoval.
 */
export function writeFileAtomic(path: string, content: Buffer): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}.part`)
  try {
    writeFileSync(tmp, content, { flag: 'wx' })
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOSPC') throw err('DISK_FULL', 'Na disku nie je dosť miesta')
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw err('WRITE_DENIED', 'Do tohto umiestnenia nemožno zapisovať')
    throw err('WRITE_FAILED', 'Súbor sa nepodarilo zapísať')
  }
  markFromInternet(path)
}

export function markFromInternet(path: string): void {
  if (process.platform !== 'win32') return
  try {
    writeFileSync(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
  } catch {
    // Iný súborový systém (FAT, sieťový disk) – značka sa nedá zapísať, súbor je aj tak uložený.
  }
}

/** Dočasné súbory príloh otvorených v inom programe. Pri štarte jadra sa staré zmažú. */
export function openDir(dataDir: string): string {
  return join(dataDir, OPEN_ATTACHMENTS_DIR)
}

export function cleanOpenDir(dataDir: string, maxAgeMs = 24 * 3600_000): void {
  const dir = openDir(dataDir)
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { recursive: true, force: true })
      } catch {
        // súbor je ešte otvorený v inom programe – skúsime nabudúce
      }
    }
  } catch {
    mkdirSync(dir, { recursive: true })
  }
}
