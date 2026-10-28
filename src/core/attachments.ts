import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BlobStore } from './store/blobs'
import type { MailStore } from './store/mailstore'
import type { SyncManager } from './sync/manager'
import { extractAttachments, type AttachmentContent } from './mail/parse'
import { FileGrants, openDir, safeFilename, uniqueName, writeFileAtomic } from './files'
import { isArchiveId, isDangerousFile, previewKind, type AttachmentPreview } from '../shared/ipc'
import type { ArchiveManager } from './archive/archive'

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export interface AttachmentCtx {
  blobs: BlobStore
  store: MailStore
  sync: SyncManager
  files: FileGrants
  dataDir: string
  archives?: ArchiveManager
}

/** Originál správy (stiahne ho, ak ešte nie je v počítači). */
export async function messageRaw(ctx: Pick<AttachmentCtx, 'blobs' | 'store' | 'sync' | 'archives'>, messageId: number): Promise<Buffer> {
  if (isArchiveId(messageId)) {
    if (!ctx.archives) throw err('NOT_FOUND', 'Správa neexistuje')
    return ctx.archives.raw(messageId)
  }
  let row = ctx.store.message(messageId)
  if (!row) throw err('NOT_FOUND', 'Správa neexistuje')
  if (!row.blob_sha256) {
    await ctx.sync.get(row.account_id)?.fetchBodyNow(messageId)
    row = ctx.store.message(messageId)
    if (!row?.blob_sha256) throw err('BODY_UNAVAILABLE', 'Obsah správy ešte nie je stiahnutý a server nie je dostupný')
  }
  return ctx.blobs.read(row.blob_sha256)
}

export async function attachmentOf(ctx: Pick<AttachmentCtx, 'blobs' | 'store' | 'sync' | 'archives'>, messageId: number, index: number): Promise<AttachmentContent> {
  const list = await extractAttachments(await messageRaw(ctx, messageId))
  const a = Number.isInteger(index) ? list[index] : undefined
  if (!a) throw err('NOT_FOUND', 'Príloha neexistuje')
  return a
}

/** Uloží prílohu do súboru, ktorý používateľ zvolil v dialógu „Uložiť ako“. */
export async function saveAttachment(ctx: AttachmentCtx, messageId: number, index: number, path: string): Promise<void> {
  const target = await ctx.files.require(path, 'write')
  const a = await attachmentOf(ctx, messageId, index)
  writeFileAtomic(target, a.content)
}

/** Uloží všetky prílohy do zvoleného priečinka; existujúce súbory neprepíše („názov (2).pdf“). */
export async function saveAllAttachments(ctx: AttachmentCtx, messageId: number, dir: string): Promise<string[]> {
  const target = await ctx.files.require(dir, 'dir')
  const list = await extractAttachments(await messageRaw(ctx, messageId))
  const used = new Set<string>()
  const saved: string[] = []
  for (const a of list) {
    const name = uniqueName(target, safeFilename(a.filename), used)
    writeFileAtomic(join(target, name), a.content)
    saved.push(name)
  }
  return saved
}

/**
 * Pripraví prílohu na otvorenie v predvolenom programe: dočasná kópia v dátovom priečinku Doaru.
 * Spustiteľné súbory (programy, skripty, skratky…) sa neotvárajú nikdy – len uložiť.
 */
export async function prepareOpen(ctx: AttachmentCtx, messageId: number, index: number): Promise<string> {
  const a = await attachmentOf(ctx, messageId, index)
  const name = safeFilename(a.filename)
  if (isDangerousFile(name)) throw err('DANGEROUS_ATTACHMENT', 'Tento typ súboru sa môže spustiť ako program – dá sa len uložiť')
  const dir = join(openDir(ctx.dataDir), randomUUID().slice(0, 12))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileAtomic(path, a.content)
  return path
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }
const MAX_PREVIEW_IMAGE = 25 * 1024 * 1024
const MAX_PREVIEW_TEXT = 2 * 1024 * 1024

/**
 * Náhľad prílohy priamo v Doare. Obrázok ide do rozhrania ako data: URI (SVG nie – môže obsahovať skripty),
 * text ako text, PDF ako dočasná kópia, ktorú zobrazí okno náhľadu v main procese (bez siete a bez Node.js).
 */
export async function previewAttachment(ctx: AttachmentCtx, messageId: number, index: number): Promise<AttachmentPreview> {
  const a = await attachmentOf(ctx, messageId, index)
  const kind = previewKind(a.filename, a.contentType)
  if (kind === 'image') {
    if (a.content.length > MAX_PREVIEW_IMAGE) throw err('PREVIEW_TOO_LARGE', 'Príloha je na náhľad príliš veľká')
    const ext = (a.filename.split('.').pop() ?? '').toLowerCase()
    const type = /^image\/(png|jpeg|gif|webp|bmp)$/.test(a.contentType.toLowerCase()) ? a.contentType.toLowerCase() : IMAGE_TYPES[ext]
    if (!type) throw err('NO_PREVIEW', 'Náhľad tohto typu súboru nie je k dispozícii')
    return { kind: 'image', dataUrl: `data:${type};base64,${a.content.toString('base64')}` }
  }
  if (kind === 'text') {
    if (a.content.length > MAX_PREVIEW_TEXT) throw err('PREVIEW_TOO_LARGE', 'Príloha je na náhľad príliš veľká')
    return { kind: 'text', text: decodeText(a.content) }
  }
  if (kind === 'pdf') {
    // Iba skutočné PDF (hlavička %PDF) – nie spustiteľný súbor s príponou .pdf.
    if (!a.content.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw err('NO_PREVIEW', 'Súbor nie je PDF')
    const dir = join(openDir(ctx.dataDir), randomUUID().slice(0, 12))
    mkdirSync(dir, { recursive: true })
    const name = safeFilename(a.filename).replace(/\.[^.]*$/, '') + '.pdf'
    const path = join(dir, name)
    writeFileAtomic(path, a.content)
    return { kind: 'pdf', path }
  }
  throw err('NO_PREVIEW', 'Náhľad tohto typu súboru nie je k dispozícii')
}

/** Text prílohy: UTF-8 (aj s BOM), inak Windows-1250 (staršie súbory zo slovenských Windows). */
function decodeText(b: Buffer): string {
  const utf = new TextDecoder('utf-8', { fatal: false }).decode(b)
  if (!utf.includes('\uFFFD')) return utf.replace(/^\uFEFF/, '')
  try {
    return new TextDecoder('windows-1250').decode(b)
  } catch {
    return utf
  }
}
