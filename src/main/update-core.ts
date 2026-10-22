import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

/**
 * Aktualizácie Doar Mail – časť bez Electronu (testovateľná v Node.js).
 *
 * Doar Mail sa dodáva ako priečinok s originálnym Electronom (pozri electron-builder.yml), bez inštalátora.
 * Aktualizácia: nová verzia sa stiahne z GitHubu (Releases), overí (veľkosť + SHA-256 z manifestu),
 * rozbalí VEDĽA bežiacej verzie („Doar Mail 0.4.1“), odkazy sa presmerujú a aplikácia sa reštartuje z nového
 * priečinka. Bežiace súbory sa nikdy neprepisujú; predošlá verzia zostane na disku (návrat späť).
 */

export const MANIFEST_NAME = 'doar-mail-update.json'
export const EXE_NAME = 'Doar Mail.exe'

export interface UpdateManifest {
  app: 'doar-mail'
  version: string
  file: string
  size: number
  sha256: string
  platform: string
}

export interface UpdateInfo {
  version: string
  notes: string
  /** Stránka vydania (na „Čo je nové“). */
  pageUrl: string | null
  file: string
  size: number
  sha256: string
  source: { kind: 'url'; url: string } | { kind: 'file'; path: string }
}

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

// ---------- verzie ----------

/** Porovná verzie „1.2.3“ / „1.2.3-beta.1“ (predbežná verzia je nižšia než vydaná). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const m = String(v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
    if (!m) return { nums: [0, 0, 0], pre: 'invalid' }
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! < y.nums[i]! ? -1 : 1
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre < y.pre ? -1 : 1
}

export function parseManifest(json: unknown): UpdateManifest {
  const m = json as Partial<UpdateManifest> | null
  const ok =
    m &&
    m.app === 'doar-mail' &&
    typeof m.version === 'string' &&
    /^\d+\.\d+\.\d+/.test(m.version) &&
    typeof m.file === 'string' &&
    /^[\w.-]+\.zip$/.test(m.file) &&
    Number.isInteger(m.size) &&
    (m.size as number) > 0 &&
    typeof m.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(m.sha256)
  if (!ok) throw err('UPDATE_BAD_MANIFEST', 'Popis aktualizácie je neplatný')
  return { app: 'doar-mail', version: m.version!, file: m.file!, size: m.size!, sha256: m.sha256!, platform: typeof m.platform === 'string' ? m.platform : 'win32-x64' }
}

// ---------- zdroje (GitHub alebo priečinok na test) ----------

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
  body: ReadableStream<Uint8Array> | null
  headers: { get(name: string): string | null }
}>

const GH_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'Doar-Mail-Updater', 'X-GitHub-Api-Version': '2022-11-28' }

/**
 * Najnovšie vydanie na GitHube (bez predbežných). Vráti null, ak vydanie nemá manifest Doar Mail
 * (napr. vydanie len so zdrojovým kódom).
 */
export async function fromGithub(fetch: FetchLike, repo: string, signal?: AbortSignal, api = 'https://api.github.com'): Promise<UpdateInfo | null> {
  const r = await fetch(`${api}/repos/${repo}/releases/latest`, { headers: GH_HEADERS, signal })
  if (r.status === 404) return null
  if (!r.ok) throw err('UPDATE_CHECK_FAILED', `GitHub odpovedal ${r.status}`)
  const rel = (await r.json()) as { tag_name?: string; body?: string; html_url?: string; assets?: { name: string; browser_download_url: string; size: number }[] }
  const assets = Array.isArray(rel.assets) ? rel.assets : []
  const m = assets.find((a) => a.name === MANIFEST_NAME)
  if (!m) return null
  const mr = await fetch(m.browser_download_url, { headers: { 'User-Agent': GH_HEADERS['User-Agent'] }, signal })
  if (!mr.ok) throw err('UPDATE_CHECK_FAILED', `Manifest: ${mr.status}`)
  const manifest = parseManifest(await mr.json())
  const zip = assets.find((a) => a.name === manifest.file)
  if (!zip) throw err('UPDATE_BAD_MANIFEST', 'Vo vydaní chýba súbor aktualizácie')
  if (zip.size && zip.size !== manifest.size) throw err('UPDATE_BAD_MANIFEST', 'Veľkosť súboru nesedí s manifestom')
  return {
    version: manifest.version,
    notes: typeof rel.body === 'string' ? rel.body.slice(0, 20_000) : '',
    pageUrl: typeof rel.html_url === 'string' && rel.html_url.startsWith('https://github.com/') ? rel.html_url : null,
    file: manifest.file,
    size: manifest.size,
    sha256: manifest.sha256,
    source: { kind: 'url', url: zip.browser_download_url }
  }
}

/** Testovací zdroj: priečinok s manifestom a zipom (napr. D:\_Doar\dist). */
export async function fromFolder(dir: string): Promise<UpdateInfo | null> {
  const p = join(dir, MANIFEST_NAME)
  if (!existsSync(p)) return null
  const manifest = parseManifest(JSON.parse(await readFile(p, 'utf8')))
  const notesFile = join(dir, 'notes.txt')
  return {
    version: manifest.version,
    notes: existsSync(notesFile) ? (await readFile(notesFile, 'utf8')).slice(0, 20_000) : '',
    pageUrl: null,
    file: manifest.file,
    size: manifest.size,
    sha256: manifest.sha256,
    source: { kind: 'file', path: join(dir, manifest.file) }
  }
}

// ---------- stiahnutie a overenie ----------

/**
 * Stiahne (alebo skopíruje) zip a overí veľkosť a SHA-256. Do cieľa sa dostane len overený súbor
 * (sťahuje sa do „.part“).
 */
export async function download(fetch: FetchLike, info: UpdateInfo, target: string, opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<void> {
  const part = `${target}.part`
  await mkdir(dirname(target), { recursive: true })
  await rm(part, { force: true })
  const hash = createHash('sha256')
  let done = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      done += chunk.length
      if (done > info.size) return cb(err('UPDATE_BAD_FILE', 'Súbor je väčší, než má byť'))
      opts.onProgress?.(done, info.size)
      cb(null, chunk)
    }
  })
  try {
    let input: NodeJS.ReadableStream
    if (info.source.kind === 'file') input = createReadStream(info.source.path)
    else {
      const r = await fetch(info.source.url, { headers: { 'User-Agent': 'Doar-Mail-Updater' }, signal: opts.signal })
      if (!r.ok || !r.body) throw err('UPDATE_DOWNLOAD_FAILED', `Sťahovanie: ${r.status}`)
      input = Readable.fromWeb(r.body as import('node:stream/web').ReadableStream<Uint8Array>)
    }
    await pipeline(input, counter, createWriteStream(part), { signal: opts.signal })
    if (done !== info.size) throw err('UPDATE_BAD_FILE', 'Súbor nie je celý')
    if (hash.digest('hex') !== info.sha256) throw err('UPDATE_BAD_FILE', 'Kontrolný súčet nesedí')
    await rm(target, { force: true })
    await rename(part, target)
  } catch (e) {
    await rm(part, { force: true }).catch(() => {})
    if ((e as { name?: string }).name === 'AbortError') throw err('UPDATE_CANCELLED', 'Zrušené')
    if ((e as { code?: string }).code?.startsWith('UPDATE_')) throw e
    throw err('UPDATE_DOWNLOAD_FAILED', (e as Error).message)
  }
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(path), new Transform({ transform: (c, _e, cb) => (h.update(c), cb()) }))
  return h.digest('hex')
}

// ---------- rozbalenie zip ----------

interface ZipEntry {
  name: string
  method: number
  flags: number
  compSize: number
  size: number
  offset: number
}

function readEntries(buf: Buffer, count: number): ZipEntry[] {
  const out: ZipEntry[] = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw err('UPDATE_BAD_FILE', 'Poškodený zip (centrálny adresár)')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    let compSize = buf.readUInt32LE(p + 20)
    let size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let offset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1')
    // ZIP64: skutočné hodnoty v extra poli 0x0001 (v poradí: veľkosť, komprimovaná veľkosť, pozícia).
    let e = p + 46 + nameLen
    const end = e + extraLen
    while (e + 4 <= end) {
      const id = buf.readUInt16LE(e)
      const len = buf.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) (size = Number(buf.readBigUInt64LE(q)), (q += 8))
        if (compSize === 0xffffffff) (compSize = Number(buf.readBigUInt64LE(q)), (q += 8))
        if (offset === 0xffffffff) offset = Number(buf.readBigUInt64LE(q))
      }
      e += 4 + len
    }
    out.push({ name, method, flags, compSize, size, offset })
    p = end + commentLen
  }
  return out
}

/** Cesta v archíve → bezpečná cesta v cieľovom priečinku (žiadne „..“, absolútne cesty ani písmená diskov). */
export function safeEntryPath(destDir: string, name: string): string | null {
  const clean = name.replace(/\\/g, '/')
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.split('/').some((s) => s === '..')) return null
  const full = normalize(join(destDir, clean))
  const root = normalize(destDir + sep)
  return full.startsWith(root) || full === normalize(destDir) ? full : null
}

/** Rozbalí zip (uložené alebo deflate, aj ZIP64). Ochrana proti „zip slip“. */
export async function extractZip(zipPath: string, destDir: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  const fh = await open(zipPath, 'r')
  let entries: ZipEntry[]
  try {
    const { size } = await fh.stat()
    const tailLen = Math.min(size, 65_557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw err('UPDATE_BAD_FILE', 'Súbor nie je zip')
    let count = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw err('UPDATE_BAD_FILE', 'Poškodený zip (ZIP64)')
      const z64Off = Number(tail.readBigUInt64LE(loc + 8))
      const z64 = Buffer.alloc(56)
      await fh.read(z64, 0, 56, z64Off)
      if (z64.readUInt32LE(0) !== 0x06064b50) throw err('UPDATE_BAD_FILE', 'Poškodený zip (ZIP64)')
      count = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
    }
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    entries = readEntries(cd, count)
    // Pozície dát: za lokálnou hlavičkou (jej dĺžka sa môže líšiť od centrálneho adresára).
    for (const en of entries) {
      const lh = Buffer.alloc(30)
      await fh.read(lh, 0, 30, en.offset)
      if (lh.readUInt32LE(0) !== 0x04034b50) throw err('UPDATE_BAD_FILE', 'Poškodený zip (lokálna hlavička)')
      en.offset = en.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
    }
  } finally {
    await fh.close()
  }
  const total = entries.reduce((s, e) => s + e.size, 0)
  let done = 0
  await mkdir(destDir, { recursive: true })
  for (const en of entries) {
    if (en.flags & 1) throw err('UPDATE_BAD_FILE', 'Zašifrovaný zip nie je podporovaný')
    const out = safeEntryPath(destDir, en.name)
    if (!out) throw err('UPDATE_BAD_FILE', `Nebezpečná cesta v archíve: ${en.name}`)
    if (en.name.endsWith('/')) {
      await mkdir(out, { recursive: true })
      continue
    }
    await mkdir(dirname(out), { recursive: true })
    if (en.compSize === 0) {
      await pipeline(Readable.from([]), createWriteStream(out))
    } else {
      const src = createReadStream(zipPath, { start: en.offset, end: en.offset + en.compSize - 1 })
      if (en.method === 0) await pipeline(src, createWriteStream(out))
      else if (en.method === 8) await pipeline(src, createInflateRaw(), createWriteStream(out))
      else throw err('UPDATE_BAD_FILE', `Nepodporovaná kompresia (${en.method})`)
    }
    const st = await stat(out)
    if (st.size !== en.size) throw err('UPDATE_BAD_FILE', `Súbor ${en.name} nemá správnu veľkosť`)
    done += en.size
    onProgress?.(done, total)
  }
}

// ---------- inštalácia vedľa bežiacej verzie ----------

/** Priečinok novej verzie vedľa bežiacej: …\Programs\Doar Mail 0.4.1 */
export function newInstallDir(currentExe: string, version: string): string {
  return join(dirname(dirname(currentExe)), `Doar Mail ${version}`)
}

/** Vyzerá priečinok ako inštalácia Doar Mail? (len také sa smú mazať pri upratovaní) */
/**
 * Electron v main procese považuje súbory „*.asar“ za archívy (čítanie aj zápis cez fs) – pri rozbaľovaní
 * a mazaní inštalácie potrebujeme obyčajné súbory. Mimo Electronu (testy) nemá nastavenie žiadny vplyv.
 */
let noAsarDepth = 0
async function withoutAsar<T>(fn: () => Promise<T>): Promise<T> {
  const p = process as { noAsar?: boolean }
  const prev = p.noAsar
  noAsarDepth++
  p.noAsar = true
  try {
    return await fn()
  } finally {
    if (--noAsarDepth === 0) p.noAsar = prev
  }
}

export function looksLikeInstall(dir: string): boolean {
  return existsSync(join(dir, EXE_NAME)) && existsSync(join(dir, 'resources', 'app.asar'))
}

/**
 * Rozbalí overený zip do nového priečinka (najprv do „.part“, potom premenuje) a overí obsah.
 * Vráti cestu k novému Doar Mail.exe.
 */
export function installBeside(zipPath: string, currentExe: string, version: string, onProgress?: (done: number, total: number) => void): Promise<string> {
  return withoutAsar(() => installBesideRaw(zipPath, currentExe, version, onProgress))
}

async function installBesideRaw(zipPath: string, currentExe: string, version: string, onProgress?: (done: number, total: number) => void): Promise<string> {
  const dir = newInstallDir(currentExe, version)
  if (normalize(dir) === normalize(dirname(currentExe))) throw err('UPDATE_SAME_DIR', 'Táto verzia už beží')
  const part = `${dir}.part`
  await rm(part, { recursive: true, force: true })
  try {
    await mkdir(dirname(dir), { recursive: true })
    await extractZip(zipPath, part, onProgress)
  } catch (e) {
    await rm(part, { recursive: true, force: true }).catch(() => {})
    if ((e as { code?: string }).code === 'EACCES' || (e as { code?: string }).code === 'EPERM') throw err('UPDATE_NOT_WRITABLE', 'Do priečinka programu sa nedá zapisovať')
    throw e
  }
  if (!looksLikeInstall(part)) {
    await rm(part, { recursive: true, force: true })
    throw err('UPDATE_BAD_FILE', 'V aktualizácii chýba program')
  }
  // Staršia nepodarená inštalácia tej istej verzie (nie bežiaca) sa nahradí.
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true })
  await rename(part, dir)
  return join(dir, EXE_NAME)
}

/**
 * Upratanie po aktualizácii: z histórie inštalácií zostane bežiaca a jedna predošlá (návrat späť);
 * staršie sa zmažú – len ak sú to naozaj inštalácie Doar Mail a nie je to bežiaci priečinok.
 */
export function cleanupOld(history: string[], currentDir: string): Promise<string[]> {
  return withoutAsar(() => cleanupOldRaw(history, currentDir))
}

async function cleanupOldRaw(history: string[], currentDir: string): Promise<string[]> {
  const norm = (p: string): string => normalize(p).toLowerCase()
  const list = history.filter((p) => isAbsolute(p) && norm(p) !== norm(currentDir))
  const keep = [...list.slice(-1), currentDir]
  for (const old of list.slice(0, -1)) {
    if (looksLikeInstall(old)) await rm(old, { recursive: true, force: true }).catch(() => {})
  }
  return keep
}

export async function removeFile(path: string): Promise<void> {
  await unlink(path).catch(() => {})
}

