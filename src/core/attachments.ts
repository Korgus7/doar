import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BlobStore } from './store/blobs'
import type { MailStore } from './store/mailstore'
import type { SyncManager } from './sync/manager'
import { extractAttachments, type AttachmentContent } from './mail/parse'
import { FileGrants, openDir, safeFilename, uniqueName, writeFileAtomic } from './files'
import { isDangerousFile } from '../shared/ipc'

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export interface AttachmentCtx {
  blobs: BlobStore
  store: MailStore
  sync: SyncManager
  files: FileGrants
  dataDir: string
}

/** Originál správy (stiahne ho, ak ešte nie je v počítači). */
export async function messageRaw(ctx: Pick<AttachmentCtx, 'blobs' | 'store' | 'sync'>, messageId: number): Promise<Buffer> {
  let row = ctx.store.message(messageId)
  if (!row) throw err('NOT_FOUND', 'Správa neexistuje')
  if (!row.blob_sha256) {
    await ctx.sync.get(row.account_id)?.fetchBodyNow(messageId)
    row = ctx.store.message(messageId)
    if (!row?.blob_sha256) throw err('BODY_UNAVAILABLE', 'Obsah správy ešte nie je stiahnutý a server nie je dostupný')
  }
  return ctx.blobs.read(row.blob_sha256)
}

export async function attachmentOf(ctx: Pick<AttachmentCtx, 'blobs' | 'store' | 'sync'>, messageId: number, index: number): Promise<AttachmentContent> {
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
