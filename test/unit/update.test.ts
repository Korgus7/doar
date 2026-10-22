import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import {
  cleanupOld, compareVersions, download, extractZip, fromFolder, fromGithub, installBeside, looksLikeInstall, MANIFEST_NAME, newInstallDir, parseManifest,
  safeEntryPath, type FetchLike, type UpdateInfo
} from '../../src/main/update-core'

/** Malý zapisovač ZIP pre testy (uložené aj deflate, voliteľne s cestou, ktorá sa snaží uniknúť). */
function makeZip(files: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const comp = f.store ? f.data : deflateRawSync(f.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x800, 6)
    lh.writeUInt16LE(f.store ? 0 : 8, 8)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(f.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x800, 8)
    ch.writeUInt16LE(f.store ? 0 : 8, 10)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(f.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += 30 + name.length + comp.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const dir = mkdtempSync(join(tmpdir(), 'doar-update-'))
const EXE = Buffer.from('MZ fake electron')
const ASAR = Buffer.alloc(200_000, 7)
const appZip = makeZip([
  { name: 'Doar Mail.exe', data: EXE, store: true },
  { name: 'resources/', data: Buffer.alloc(0), store: true },
  { name: 'resources/app.asar', data: ASAR },
  { name: 'resources/icon.ico', data: Buffer.from('ico') },
  { name: 'locales/sk.pak', data: Buffer.from('slovenčina') }
])

let server: Server
let base = ''
const routes = new Map<string, { status: number; body: Buffer | string; type?: string }>()

beforeAll(async () => {
  server = createServer((req, res) => {
    const r = routes.get(req.url ?? '')
    if (!r) {
      res.statusCode = 404
      res.end()
      return
    }
    res.statusCode = r.status
    res.setHeader('content-type', r.type ?? 'application/octet-stream')
    res.end(r.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => server.close())

const fetchLike: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>

describe('aktualizácie – verzie a manifest', () => {
  it('porovnanie verzií', () => {
    expect(compareVersions('0.4.0', '0.3.9')).toBe(1)
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0)
    expect(compareVersions('v0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.4.0-beta.1', '0.4.0')).toBe(-1)
    expect(compareVersions('0.4.0', '0.4.0-beta.2')).toBe(1)
    expect(compareVersions('nezmysel', '0.0.1')).toBe(-1)
  })

  it('manifest: overenie polí (názov súboru bez ciest, SHA-256)', () => {
    const ok = { app: 'doar-mail', version: '0.4.0', file: 'Doar-Mail-0.4.0-win-x64.zip', size: 10, sha256: 'a'.repeat(64) }
    expect(parseManifest(ok).version).toBe('0.4.0')
    for (const bad of [{ ...ok, app: 'iny' }, { ...ok, file: '../x.zip' }, { ...ok, file: 'a\\b.zip' }, { ...ok, sha256: 'xyz' }, { ...ok, size: 0 }, null]) {
      expect(() => parseManifest(bad)).toThrow(expect.objectContaining({ code: 'UPDATE_BAD_MANIFEST' }))
    }
  })
})

describe('aktualizácie – GitHub a stiahnutie', () => {
  const manifest = { app: 'doar-mail', version: '0.4.1', file: 'Doar-Mail-0.4.1-win-x64.zip', size: appZip.length, sha256: sha(appZip), platform: 'win32-x64' }

  it('najnovšie vydanie z GitHubu: manifest a zip z príloh vydania', async () => {
    const assets = [
      { name: MANIFEST_NAME, browser_download_url: `${base}/m.json`, size: 100 },
      { name: manifest.file, browser_download_url: `${base}/app.zip`, size: appZip.length }
    ]
    routes.set('/m.json', { status: 200, body: JSON.stringify(manifest), type: 'application/json' })
    routes.set('/app.zip', { status: 200, body: appZip })
    const gh: FetchLike = (url, init) =>
      url === 'https://api.github.com/repos/Korgus7/doar/releases/latest'
        ? (Promise.resolve(new Response(JSON.stringify({ tag_name: 'v0.4.1', body: 'Novinky:\n- aktualizácie', html_url: 'https://github.com/Korgus7/doar/releases/tag/v0.4.1', assets }), { status: 200 })) as unknown as ReturnType<FetchLike>)
        : fetchLike(url, init)
    const info = (await fromGithub(gh, 'Korgus7/doar'))!
    expect(info).toMatchObject({ version: '0.4.1', notes: 'Novinky:\n- aktualizácie', size: appZip.length, sha256: manifest.sha256, source: { kind: 'url', url: `${base}/app.zip` } })
    expect(info.pageUrl).toBe('https://github.com/Korgus7/doar/releases/tag/v0.4.1')

    // Stiahnutie s priebehom a overením.
    const target = join(dir, 'dl', manifest.file)
    let last = 0
    await download(fetchLike, info, target, { onProgress: (d) => (last = d) })
    expect(readFileSync(target).equals(appZip)).toBe(true)
    expect(last).toBe(appZip.length)
    expect(existsSync(`${target}.part`)).toBe(false)
  })

  it('vydanie bez manifestu Doar Mail → nič (nie chyba); GitHub nedostupný → chyba', async () => {
    const noAssets: FetchLike = () => Promise.resolve(new Response(JSON.stringify({ assets: [] }), { status: 200 })) as unknown as ReturnType<FetchLike>
    expect(await fromGithub(noAssets, 'Korgus7/doar')).toBeNull()
    const down: FetchLike = () => Promise.resolve(new Response('', { status: 503 })) as unknown as ReturnType<FetchLike>
    await expect(fromGithub(down, 'Korgus7/doar')).rejects.toMatchObject({ code: 'UPDATE_CHECK_FAILED' })
  })

  it('poškodený alebo podvrhnutý súbor sa nepoužije (SHA-256, veľkosť)', async () => {
    const bad = Buffer.from(appZip)
    bad[100] = bad[100]! ^ 0xff
    routes.set('/bad.zip', { status: 200, body: bad })
    routes.set('/short.zip', { status: 200, body: appZip.subarray(0, appZip.length - 50) })
    const target = join(dir, 'dl', 'x.zip')
    const info: UpdateInfo = { version: '0.4.1', notes: '', pageUrl: null, file: 'x.zip', size: appZip.length, sha256: sha(appZip), source: { kind: 'url', url: `${base}/bad.zip` } }
    await expect(download(fetchLike, info, target)).rejects.toMatchObject({ code: 'UPDATE_BAD_FILE' })
    await expect(download(fetchLike, { ...info, source: { kind: 'url', url: `${base}/short.zip` } }, target)).rejects.toMatchObject({ code: 'UPDATE_BAD_FILE' })
    await expect(download(fetchLike, { ...info, source: { kind: 'url', url: `${base}/nie.zip` } }, target)).rejects.toMatchObject({ code: 'UPDATE_DOWNLOAD_FAILED' })
    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${target}.part`)).toBe(false)
  })

  it('testovací zdroj: priečinok s manifestom a zipom (ako dist po npm run dist)', async () => {
    const feed = join(dir, 'feed')
    mkdirSync(feed, { recursive: true })
    writeFileSync(join(feed, manifest.file), appZip)
    writeFileSync(join(feed, MANIFEST_NAME), JSON.stringify(manifest))
    const info = (await fromFolder(feed))!
    expect(info.source).toEqual({ kind: 'file', path: join(feed, manifest.file) })
    await download(fetchLike, info, join(dir, 'dl2', manifest.file))
    expect(sha(readFileSync(join(dir, 'dl2', manifest.file)))).toBe(manifest.sha256)
    expect(await fromFolder(join(dir, 'prazdny'))).toBeNull()
  })
})

describe('aktualizácie – rozbalenie a inštalácia vedľa bežiacej verzie', () => {
  it('zip: uložené aj deflate, priečinky, diakritika; zip z príkazu zip', async () => {
    const z = join(dir, 'a.zip')
    writeFileSync(z, appZip)
    const out = join(dir, 'a')
    await extractZip(z, out)
    expect(readFileSync(join(out, 'Doar Mail.exe')).equals(EXE)).toBe(true)
    expect(readFileSync(join(out, 'resources', 'app.asar')).equals(ASAR)).toBe(true)
    expect(readFileSync(join(out, 'locales', 'sk.pak'), 'utf8')).toBe('slovenčina')
    // Skutočný zip z nástroja (ak je k dispozícii).
    try {
      const src = join(dir, 'zsrc')
      mkdirSync(join(src, 'resources'), { recursive: true })
      writeFileSync(join(src, 'Doar Mail.exe'), EXE)
      writeFileSync(join(src, 'resources', 'app.asar'), ASAR)
      execFileSync('zip', ['-qr', join(dir, 'tool.zip'), '.'], { cwd: src })
    } catch {
      return
    }
    await extractZip(join(dir, 'tool.zip'), join(dir, 'tool'))
    expect(looksLikeInstall(join(dir, 'tool'))).toBe(true)
  })

  it('cesty, ktoré by unikli z priečinka, sa odmietnu', async () => {
    expect(safeEntryPath('/x/y', '../evil.exe')).toBeNull()
    expect(safeEntryPath('/x/y', 'a/../../evil')).toBeNull()
    expect(safeEntryPath('/x/y', '/etc/passwd')).toBeNull()
    expect(safeEntryPath('/x/y', 'C:/Windows/evil.exe')).toBeNull()
    expect(safeEntryPath('/x/y', 'a\\..\\..\\evil')).toBeNull()
    expect(safeEntryPath('/x/y', 'resources/app.asar')).toBe(join('/x/y', 'resources', 'app.asar'))
    const z = join(dir, 'evil.zip')
    writeFileSync(z, makeZip([{ name: '../evil.txt', data: Buffer.from('x') }]))
    await expect(extractZip(z, join(dir, 'evil'))).rejects.toMatchObject({ code: 'UPDATE_BAD_FILE' })
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false)
  })

  it('inštalácia vedľa: …\\Doar Mail 0.4.1, bežiaca verzia sa nezmení; chýbajúci program → chyba', async () => {
    const programs = join(dir, 'Programs')
    const cur = join(programs, 'Doar Mail')
    mkdirSync(join(cur, 'resources'), { recursive: true })
    writeFileSync(join(cur, 'Doar Mail.exe'), 'stara verzia')
    writeFileSync(join(cur, 'resources', 'app.asar'), 'stara')
    const z = join(dir, 'upd.zip')
    writeFileSync(z, appZip)
    const exe = await installBeside(z, join(cur, 'Doar Mail.exe'), '0.4.1')
    expect(exe).toBe(join(programs, 'Doar Mail 0.4.1', 'Doar Mail.exe'))
    expect(newInstallDir(join(cur, 'Doar Mail.exe'), '0.4.1')).toBe(join(programs, 'Doar Mail 0.4.1'))
    expect(readFileSync(exe).equals(EXE)).toBe(true)
    expect(readFileSync(join(cur, 'Doar Mail.exe'), 'utf8')).toBe('stara verzia')
    expect(existsSync(join(programs, 'Doar Mail 0.4.1.part'))).toBe(false)
    // Opakovaná inštalácia tej istej verzie (napr. po prerušení) nahradí neúplný priečinok.
    await installBeside(z, join(cur, 'Doar Mail.exe'), '0.4.1')
    expect(looksLikeInstall(join(programs, 'Doar Mail 0.4.1'))).toBe(true)

    const noExe = join(dir, 'noexe.zip')
    writeFileSync(noExe, makeZip([{ name: 'readme.txt', data: Buffer.from('x') }]))
    await expect(installBeside(noExe, join(cur, 'Doar Mail.exe'), '0.4.2')).rejects.toMatchObject({ code: 'UPDATE_BAD_FILE' })
    expect(existsSync(join(programs, 'Doar Mail 0.4.2'))).toBe(false)
  })

  it('upratanie: zostane bežiaca a jedna predošlá verzia; cudzie priečinky sa nemažú', async () => {
    const p = join(dir, 'P2')
    const mk = (name: string, real = true): string => {
      const d = join(p, name)
      mkdirSync(join(d, 'resources'), { recursive: true })
      if (real) {
        writeFileSync(join(d, 'Doar Mail.exe'), 'x')
        writeFileSync(join(d, 'resources', 'app.asar'), 'x')
      }
      return d
    }
    const v1 = mk('Doar Mail')
    const v2 = mk('Doar Mail 0.4.1')
    const v3 = mk('Doar Mail 0.4.2')
    const foreign = mk('Moje dokumenty', false)
    const keep = await cleanupOld([foreign, v1, v2, v3], v3)
    expect(keep).toEqual([v2, v3])
    expect(existsSync(v1)).toBe(false)
    expect(existsSync(v2)).toBe(true)
    expect(existsSync(v3)).toBe(true)
    expect(existsSync(foreign)).toBe(true) // nie je inštalácia Doar Mail → nezmaže sa
    expect(await cleanupOld([v3], v3)).toEqual([v3])
  })
})
