import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync, statSync, readdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

/**
 * Úložisko originálnych správ (.eml) adresované podľa SHA-256.
 * Originály sa po zapísaní nikdy nemenia.
 */
export class BlobStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  static hash(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex')
  }

  pathOf(sha: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('INVALID_BLOB_ID')
    return join(this.root, sha.slice(0, 2), sha.slice(2, 4), `${sha}.eml`)
  }

  has(sha: string): boolean {
    return existsSync(this.pathOf(sha))
  }

  /** Uloží správu atomicky (dočasný súbor → fsync → premenovanie). Vráti SHA-256. */
  put(data: Uint8Array): string {
    const sha = BlobStore.hash(data)
    const target = this.pathOf(sha)
    if (existsSync(target)) return sha
    mkdirSync(join(this.root, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true })
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      let off = 0
      while (off < data.length) off += writeSync(fd, data, off)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      renameSync(tmp, target)
    } catch (e) {
      // Súbežný zápis tej istej správy – výsledok je rovnaký.
      if (existsSync(target)) unlinkSync(tmp)
      else throw e
    }
    return sha
  }

  read(sha: string): Buffer {
    return readFileSync(this.pathOf(sha))
  }

  stream(sha: string): Readable {
    return createReadStream(this.pathOf(sha))
  }

  size(sha: string): number {
    return statSync(this.pathOf(sha)).size
  }

  /** Overí, že obsah súboru stále zodpovedá jeho hashu. */
  verify(sha: string): boolean {
    return BlobStore.hash(this.read(sha)) === sha
  }

  /**
   * Zmaže súbory, na ktoré už nič neodkazuje (napr. po odstránení konta). Súbory novšie než `minAgeMs`
   * nechá – mohli vzniknúť práve teraz a odkaz na ne sa ešte len zapisuje. Vráti počet zmazaných.
   */
  collectGarbage(referenced: Set<string>, minAgeMs = 10 * 60_000): number {
    const limit = Date.now() - minAgeMs
    let removed = 0
    for (const a of safeList(this.root)) {
      if (!/^[0-9a-f]{2}$/.test(a)) continue
      for (const b of safeList(join(this.root, a))) {
        if (!/^[0-9a-f]{2}$/.test(b)) continue
        const dir = join(this.root, a, b)
        for (const f of safeList(dir)) {
          const m = /^([0-9a-f]{64})\.eml$/.exec(f)
          if (!m || referenced.has(m[1]!)) continue
          const p = join(dir, f)
          try {
            if (statSync(p).mtimeMs > limit) continue
            unlinkSync(p)
            removed++
          } catch {
            // súbor medzitým zmizol alebo je zamknutý – nevadí
          }
        }
        try {
          rmdirSync(dir) // len ak je prázdny
        } catch {
          /* nie je prázdny */
        }
      }
    }
    return removed
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
