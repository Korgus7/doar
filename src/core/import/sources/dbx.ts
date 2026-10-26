import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { decodeAnsi, headerDate, plainName, yieldNow, type SourceInfo, type SourceMessage } from './common'

/**
 * Outlook Express 5 a 6: každý priečinok je súbor .dbx, zoznam priečinkov a ich hierarchia je vo Folders.dbx.
 * Formát nie je oficiálne zdokumentovaný; postup podľa verejného popisu formátu („Inside Outlook Express“,
 * A. Schloh) – vlastná implementácia, žiadna cudzia knižnica.
 *
 * Súbor .dbx:
 *  - hlavička (0x24BC bajtov): 0x00 podpis CF AD 12 FE, 0x04 typ (C5 FD 74 6F = správy, C6 FD 74 6F = priečinky),
 *    0xC4 počet položiek, 0xE4 adresa koreňa stromu indexu,
 *  - strom indexu: uzly s položkami (ukazovateľ na „info objekt“ + podstrom),
 *  - info objekt: tabuľka vlastností (index 0x04 = adresa správy, 0x01 = príznaky, 0x12 = dátum prijatia…),
 *  - správa: reťaz blokov (hlavička 16 bajtov: vlastná adresa, veľkosť bloku, dĺžka dát, adresa ďalšieho bloku).
 */

const SIG = 0xfe12adcf
const TYPE_MESSAGES = 0x6f74fdc5
const TYPE_FOLDERS = 0x6f74fdc6
const HEADER_SIZE = 0x24bc
const OFF_COUNT = 0xc4
const OFF_ROOT = 0xe4
const NODE_SIZE = 0x27c
const MAX_MESSAGE = 100 * 1024 * 1024
const MAX_ITEMS = 2_000_000

// Príznaky správy (vlastnosť 0x01). Overené: prečítaná. Ostatné podľa popisu formátu – overí sa na skutočných súboroch.
const FLAG_READ = 0x80
const FLAG_ANSWERED = 0x80000

export class NotDbxError extends Error {
  readonly code = 'NOT_DBX'
  constructor() {
    super('Súbor nie je priečinok Outlook Express (.dbx)')
  }
}

class Reader {
  private constructor(
    private readonly fh: FileHandle,
    readonly size: number
  ) {}

  static async open(path: string): Promise<Reader> {
    const fh = await open(path, 'r')
    const st = await fh.stat()
    return new Reader(fh, st.size)
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new Error('mimo súboru')
    const buf = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await this.fh.read(buf, got, length - got, offset + got)
      if (!bytesRead) break
      got += bytesRead
    }
    if (got !== length) throw new Error('krátke čítanie')
    return buf
  }

  close(): Promise<void> {
    return this.fh.close()
  }
}

async function header(r: Reader): Promise<{ type: number; count: number; root: number }> {
  if (r.size < HEADER_SIZE) throw new NotDbxError()
  const h = await r.read(0, 0x100)
  if (h.readUInt32LE(0) !== SIG) throw new NotDbxError()
  const type = h.readUInt32LE(4)
  if (type !== TYPE_MESSAGES && type !== TYPE_FOLDERS) throw new NotDbxError()
  return { type, count: h.readUInt32LE(OFF_COUNT), root: h.readUInt32LE(OFF_ROOT) }
}

/** Adresy info objektov zo stromu indexu (v poradí stromu). */
async function treeValues(r: Reader, root: number): Promise<number[]> {
  const out: number[] = []
  const seen = new Set<number>()
  const walk = async (node: number, depth: number): Promise<void> => {
    if (!node || depth > 64 || seen.has(node) || node + NODE_SIZE > r.size || out.length > MAX_ITEMS) return
    seen.add(node)
    const n = await r.read(node, NODE_SIZE)
    if (n.readUInt32LE(0) !== node) return // značka objektu = jeho vlastná adresa
    const child = n.readUInt32LE(8)
    const entries = Math.min(n[0x11]!, 0x19)
    await walk(child, depth + 1)
    for (let i = 0; i < entries; i++) {
      const e = 0x18 + i * 12
      const value = n.readUInt32LE(e)
      const sub = n.readUInt32LE(e + 4)
      if (value) out.push(value)
      await walk(sub, depth + 1)
    }
  }
  await walk(root, 0)
  return out
}

type Props = Map<number, { direct: number } | { data: Buffer }>

/** Info objekt: tabuľka vlastností. Priama hodnota (do 3 bajtov) alebo posun do dátovej časti objektu. */
async function infoObject(r: Reader, at: number): Promise<Props> {
  const h = await r.read(at, 12)
  if (h.readUInt32LE(0) !== at) throw new Error('info objekt')
  const bodyLen = h.readUInt32LE(4)
  const count = h[10]!
  if (bodyLen > 1024 * 1024 || count * 4 > bodyLen + 4) throw new Error('info objekt')
  const body = await r.read(at + 12, Math.min(bodyLen, r.size - at - 12))
  const dataStart = count * 4
  const props: Props = new Map()
  const offsets: { idx: number; off: number }[] = []
  for (let i = 0; i < count; i++) {
    const v = body.readUInt32LE(i * 4)
    const idx = v & 0x7f
    const val = v >>> 8
    if (v & 0x80) props.set(idx, { direct: val })
    else offsets.push({ idx, off: dataStart + val })
  }
  // Dĺžka dát vlastnosti = po začiatok ďalšej (posuny idú vzostupne), posledná po koniec objektu.
  const sorted = [...offsets].sort((a, b) => a.off - b.off)
  for (let i = 0; i < sorted.length; i++) {
    const { idx, off } = sorted[i]!
    const end = i + 1 < sorted.length ? sorted[i + 1]!.off : body.length
    if (off >= 0 && off <= body.length) props.set(idx, { data: body.subarray(off, Math.max(off, Math.min(end, body.length))) })
  }
  return props
}

function propInt(p: Props, idx: number): number | null {
  const v = p.get(idx)
  if (!v) return null
  if ('direct' in v) return v.direct
  return v.data.length >= 4 ? v.data.readUInt32LE(0) : null
}

function propString(p: Props, idx: number): string | null {
  const v = p.get(idx)
  if (!v || 'direct' in v) return null
  const z = v.data.indexOf(0)
  return decodeAnsi(z >= 0 ? v.data.subarray(0, z) : v.data)
}

/** FILETIME (100 ns od 1. 1. 1601) → Date. */
function propTime(p: Props, idx: number): Date | null {
  const v = p.get(idx)
  if (!v || 'direct' in v || v.data.length < 8) return null
  const ft = v.data.readBigUInt64LE(0)
  if (ft === 0n) return null
  const ms = Number(ft / 10000n) - 11644473600000
  return ms > 0 && ms < 4102444800000 ? new Date(ms) : null
}

/** Správa: reťaz blokov od danej adresy. */
async function messageAt(r: Reader, at: number): Promise<Buffer> {
  const parts: Buffer[] = []
  let total = 0
  const seen = new Set<number>()
  let pos = at
  while (pos) {
    if (seen.has(pos) || pos + 16 > r.size) throw new Error('reťaz blokov')
    seen.add(pos)
    const h = await r.read(pos, 16)
    if (h.readUInt32LE(0) !== pos) throw new Error('blok správy')
    const blockSize = h.readUInt32LE(4)
    const len = h.readUInt16LE(8)
    if (len > blockSize || pos + 16 + len > r.size) throw new Error('blok správy')
    parts.push(await r.read(pos + 16, len))
    total += len
    if (total > MAX_MESSAGE) throw new Error('príliš veľká správa')
    pos = h.readUInt32LE(12)
  }
  return Buffer.concat(parts, total)
}

export interface DbxFolder {
  /** Súbor priečinka (plná cesta). */
  file: string
  /** Cesta priečinka (názvy od najvyššej úrovne). */
  path: string[]
}

/**
 * Priečinky Outlook Expressu: z Folders.dbx (názvy a hierarchia), inak každý .dbx v priečinku samostatne
 * (názov podľa súboru). Kontajnery bez vlastného súboru (Miestne priečinky, účty IMAP) sa v ceste vynechajú.
 */
export async function dbxFolders(path: string): Promise<DbxFolder[]> {
  const st = await stat(path)
  if (st.isFile()) {
    if (/^folders\.dbx$/i.test(basename(path))) return dbxFolders(dirname(path))
    return [{ file: path, path: [basename(path).replace(/\.dbx$/i, '')] }]
  }
  const names = (await readdir(path)).filter((n) => /\.dbx$/i.test(n)).sort()
  const byPlain = new Map(names.map((n) => [plainName(n), n]))
  const out: DbxFolder[] = []
  const used = new Set<string>()
  const index = names.find((n) => /^folders\.dbx$/i.test(n))
  if (index) {
    try {
      const r = await Reader.open(join(path, index))
      try {
        const h = await header(r)
        if (h.type === TYPE_FOLDERS) {
          const rows: { id: number; parent: number; name: string; file: string | null }[] = []
          for (const at of await treeValues(r, h.root)) {
            try {
              const p = await infoObject(r, at)
              const id = propInt(p, 0x00)
              if (id === null) continue
              rows.push({ id, parent: propInt(p, 0x01) ?? 0, name: propString(p, 0x02) ?? '', file: propString(p, 0x03) })
            } catch {
              /* poškodený záznam priečinka – súbor sa pridá nižšie podľa názvu */
            }
          }
          const byId = new Map(rows.map((x) => [x.id, x]))
          const fileOf = (x: { file: string | null }): string | undefined => (x.file ? byPlain.get(plainName(x.file)) : undefined)
          for (const row of rows) {
            const file = fileOf(row)
            if (!file || used.has(file)) continue
            const segs: string[] = []
            let cur: (typeof rows)[number] | undefined = row
            const guard = new Set<number>()
            while (cur && !guard.has(cur.id)) {
              guard.add(cur.id)
              if (cur === row || fileOf(cur)) segs.unshift(cur.name || file.replace(/\.dbx$/i, ''))
              cur = cur.parent !== cur.id ? byId.get(cur.parent) : undefined
            }
            used.add(file)
            out.push({ file: join(path, file), path: segs })
          }
        }
      } finally {
        await r.close()
      }
    } catch {
      /* Folders.dbx sa nedá prečítať – priečinky podľa názvov súborov */
    }
  }
  for (const n of names) {
    if (used.has(n) || /^(folders|offline|pop3uidl|cleanup)\.dbx$/i.test(n)) continue
    out.push({ file: join(path, n), path: [n.replace(/\.dbx$/i, '')] })
  }
  return out
}

export async function dbxInfo(path: string): Promise<SourceInfo> {
  const folders = await dbxFolders(path)
  let messages = 0
  let valid = 0
  for (const f of folders) {
    try {
      const r = await Reader.open(f.file)
      try {
        const h = await header(r)
        if (h.type !== TYPE_MESSAGES) continue
        messages += h.count
        valid++
      } finally {
        await r.close()
      }
    } catch {
      /* nie je to priečinok so správami */
    }
  }
  if (!valid) throw new NotDbxError()
  return { format: 'dbx', messages, folders: valid }
}

export async function* readDbx(path: string, opts: { signal?: AbortSignal; onSkip?: () => void } = {}): AsyncGenerator<SourceMessage> {
  for (const f of await dbxFolders(path)) {
    let r: Reader
    try {
      r = await Reader.open(f.file)
    } catch {
      continue
    }
    try {
      let h
      try {
        h = await header(r)
      } catch {
        continue
      }
      if (h.type !== TYPE_MESSAGES) continue
      for (const at of await treeValues(r, h.root)) {
        if (opts.signal?.aborted) return
        let msg: SourceMessage
        try {
          const p = await infoObject(r, at)
          const addr = propInt(p, 0x04)
          if (!addr) throw new Error('bez správy')
          const raw = await messageAt(r, addr)
          if (!raw.length) throw new Error('prázdna')
          const flagsRaw = propInt(p, 0x01) ?? 0
          const flags = new Set<string>()
          if (flagsRaw & FLAG_READ) flags.add('\\Seen')
          if (flagsRaw & FLAG_ANSWERED) flags.add('\\Answered')
          msg = { raw, folder: f.path, flags, internalDate: propTime(p, 0x12) ?? propTime(p, 0x02) ?? headerDate(raw) }
        } catch {
          opts.onSkip?.()
          continue
        }
        yield msg
        await yieldNow()
      }
    } finally {
      await r.close()
    }
  }
}
