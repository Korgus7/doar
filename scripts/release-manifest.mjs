#!/usr/bin/env node
/**
 * Po `electron-builder`: zapíše dist/doar-mail-update.json (verzia, súbor, veľkosť, SHA-256).
 * Doar Mail podľa neho pozná novú verziu a overí stiahnutý zip. Do vydania na GitHube (Releases)
 * treba priložiť OBA súbory: zip aj doar-mail-update.json.
 */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const file = `Doar-Mail-${pkg.version}-win-x64.zip`
const path = join(root, 'dist', file)
const size = statSync(path).size
const hash = createHash('sha256')
await new Promise((resolve, reject) => createReadStream(path).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject))
const manifest = { app: 'doar-mail', version: pkg.version, file, size, sha256: hash.digest('hex'), platform: 'win32-x64' }
writeFileSync(join(root, 'dist', 'doar-mail-update.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`dist/doar-mail-update.json: ${pkg.version}, ${size} B, sha256 ${manifest.sha256}`)
