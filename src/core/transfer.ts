import type { ImapFlow } from 'imapflow'
import type { Db } from './store/db'
import type { BlobStore } from './store/blobs'
import { normalizeMessageId, type MailStore, type MessageRow } from './store/mailstore'
import type { SyncManager } from './sync/manager'
import type { CoreEvents, EventChannel, TransferSummary } from '../shared/ipc'
import { topLevel } from './sync/account-sync'
import { createLocalFolder, deletableSubtree } from './sync/local-folders'
import { indexInfo } from './mail/parse'
import { classifyError } from './mail/connection-test'
import { logger } from './log'

const log = logger('transfer')

/**
 * Presun a kópia medzi kontami (správy aj celé priečinky). Správy sa nahrajú do cieľového konta
 * (na jeho server, alebo lokálne, ak je cieľ len v počítači). Pri presune idú v pôvodnom konte do Koša –
 * až keď ich cieľ prijal. Správy, ktoré v cieli už sú (rovnaké Message-ID), sa druhýkrát nenahrajú.
 */
export interface TransferCtx {
  db: Db
  store: MailStore
  blobs: BlobStore
  sync: SyncManager
  emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
}

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Cieľové konto: priečinky a nahrávanie správ. */
interface Target {
  /** Priečinok v cieli (existujúci s rovnakým názvom, alebo nový). parentPath null = najvyššia úroveň. */
  folder(parentPath: string | null, name: string): Promise<string>
  /** Message-ID správ, ktoré v priečinku už sú. */
  existing(path: string): Promise<Set<string>>
  /** Nahrá správu. false = cieľ ju odmietol. */
  put(path: string, raw: Buffer, row: MessageRow): Promise<boolean>
  close(): Promise<void>
}

function flagsOf(row: MessageRow): string[] {
  return [...(row.seen ? ['\\Seen'] : []), ...(row.flagged ? ['\\Flagged'] : []), ...(row.answered ? ['\\Answered'] : [])]
}

async function imapTarget(ctx: TransferCtx, accountId: number): Promise<Target> {
  const client: ImapFlow = await ctx.sync.newImapClient(accountId)
  await client.connect()
  let list = await client.list()
  const delimiter = list.find((f) => f.delimiter)?.delimiter || '/'
  const find = (path: string) => list.find((f) => f.path.toLowerCase() === path.toLowerCase())
  return {
    async folder(parentPath, name) {
      if (name.includes(delimiter)) throw fail('INVALID_FOLDER_NAME', 'Názov obsahuje oddeľovač priečinkov')
      const path = parentPath ? `${parentPath}${delimiter}${name}` : topLevel(client, name)
      const hit = find(path)
      if (hit) return hit.path
      try {
        await client.mailboxCreate(path)
      } catch (e) {
        if (!client.usable) throw e
        throw fail('FOLDER_CREATE_FAILED', 'Server priečinok nevytvoril')
      }
      list = await client.list()
      return path
    },
    async existing(path) {
      const out = new Set<string>()
      const lock = await client.getMailboxLock(path)
      try {
        if (client.mailbox && client.mailbox.exists > 0) {
          for await (const m of client.fetch('1:*', { envelope: true })) {
            const id = normalizeMessageId(m.envelope?.messageId)
            if (id) out.add(id)
          }
        }
      } finally {
        lock.release()
      }
      return out
    },
    async put(path, raw, row) {
      try {
        const res = await client.append(path, raw, flagsOf(row), row.internal_date ? new Date(row.internal_date) : new Date())
        return res !== false
      } catch (e) {
        if (!client.usable) throw e
        log.warn('server správu neprijal', { account: accountId, code: classifyError(e).code })
        return false
      }
    },
    async close() {
      await client.logout().catch(() => {})
      client.close()
    }
  }
}

/** Cieľ je konto len v počítači: priečinky a správy len v lokálnej databáze. */
function localTarget(ctx: TransferCtx, accountId: number): Target {
  const touched = new Set<number>()
  const byPath = (path: string) => ctx.store.folderMeta(accountId).find((f) => f.path === path && !f.hidden)
  return {
    async folder(parentPath, name) {
      const d = ctx.store.folderDelimiter(accountId)
      const path = parentPath ? `${parentPath}${d}${name}` : `${ctx.store.topLevelPrefix(accountId)}${name}`
      const hit = ctx.store.folderMeta(accountId).find((f) => !f.hidden && f.path.toLowerCase() === path.toLowerCase())
      if (hit) return hit.path
      return createLocalFolder(ctx.store, accountId, parentPath, name).path
    },
    async existing(path) {
      const f = byPath(path)
      return f ? ctx.store.folderMessageIdSet(f.id) : new Set()
    },
    async put(path, raw, row) {
      const f = byPath(path)
      if (!f || !row.blob_sha256) return false
      const id = ctx.store.copyMessageLocal(row.id, f.id)
      if (id === null) return false
      ctx.store.setBody(id, row.blob_sha256, await indexInfo(raw))
      touched.add(f.id)
      return true
    },
    async close() {
      ctx.store.recountLocal([...touched])
      ctx.emit('messages.changed', { folderIds: [...touched] })
      ctx.emit('folders.changed', { accountId })
    }
  }
}

function isLocal(ctx: TransferCtx, accountId: number): boolean {
  const r = ctx.db.prepare('SELECT local_only FROM accounts WHERE id = ?').get(accountId) as { local_only: number } | undefined
  if (!r) throw fail('NO_ACCOUNT', 'Konto neexistuje')
  return !!r.local_only
}

async function openTarget(ctx: TransferCtx, accountId: number): Promise<Target> {
  if (isLocal(ctx, accountId)) return localTarget(ctx, accountId)
  if (ctx.sync.protocolOf(accountId) === 'graph') throw fail('GRAPH_UNSUPPORTED', 'Do kont cez Microsoft Graph sa zatiaľ presúvať nedá')
  return imapTarget(ctx, accountId)
}

/** Obsah správy: z počítača, inak ho skúsi stiahnuť zo servera pôvodného konta. */
async function rawOf(ctx: TransferCtx, row: MessageRow): Promise<{ raw: Buffer; row: MessageRow } | null> {
  let r = row
  if (!r.blob_sha256) {
    await ctx.sync
      .get(r.account_id)
      ?.fetchBodyNow(r.id)
      .catch(() => {})
    r = ctx.store.message(r.id) ?? r
  }
  if (!r.blob_sha256) return null
  try {
    return { raw: ctx.blobs.read(r.blob_sha256), row: r }
  } catch {
    return null
  }
}

let running = false

class Run {
  summary: TransferSummary
  /** Správy, ktoré sú v cieli (nahraté alebo tam už boli) – pri presune idú v pôvodnom konte do Koša. */
  done: number[] = []

  constructor(
    private ctx: TransferCtx,
    total: number,
    copy: boolean,
    private targetAccountId: number
  ) {
    this.summary = { total, transferred: 0, duplicates: 0, unavailable: 0, failed: 0, copy }
  }

  progress(): void {
    const s = this.summary
    this.ctx.emit('transfer.progress', { accountId: this.targetAccountId, done: s.transferred + s.duplicates + s.unavailable + s.failed, total: s.total, copy: s.copy })
  }

  async folder(target: Target, path: string, ids: number[]): Promise<void> {
    if (!ids.length) return
    const have = await target.existing(path)
    for (const id of ids) {
      const row = this.ctx.store.message(id)
      if (!row) continue
      const key = normalizeMessageId(row.message_id)
      if (key && have.has(key)) {
        this.summary.duplicates++
        this.done.push(id)
      } else {
        const got = await rawOf(this.ctx, row)
        if (!got) this.summary.unavailable++
        else if (await target.put(path, got.raw, got.row)) {
          this.summary.transferred++
          this.done.push(id)
          if (key) have.add(key)
        } else this.summary.failed++
      }
      this.progress()
    }
  }
}

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (running) throw fail('TRANSFER_RUNNING', 'Presun medzi kontami už prebieha')
  running = true
  try {
    return await fn()
  } finally {
    running = false
  }
}

function finish(ctx: TransferCtx, run: Run, targetAccountId: number, e: unknown): TransferSummary {
  if (e) {
    run.summary.interrupted = (e as { code?: string }).code ?? classifyError(e).code ?? 'ERROR'
    log.warn('presun medzi kontami prerušený', { account: targetAccountId, code: run.summary.interrupted })
  }
  log.info('presun medzi kontami', { account: targetAccountId, ...run.summary })
  // Cieľ načíta nové správy hneď (nečakať na pravidelnú synchronizáciu).
  void ctx.sync.syncNow(targetAccountId).catch(() => {})
  ctx.emit('transfer.progress', { accountId: targetAccountId, done: run.summary.total, total: run.summary.total, copy: run.summary.copy })
  return run.summary
}

/** Správy (z jedného konta) do priečinka iného konta. */
export function transferMessages(ctx: TransferCtx, ids: number[], targetFolderId: number, copy: boolean): Promise<TransferSummary> {
  return exclusive(async () => {
    const dest = ctx.store.folder(targetFolderId)
    if (!dest || !dest.selectable) throw fail('NO_TARGET', 'Cieľový priečinok neexistuje')
    const rows = ids.map((id) => ctx.store.message(id)).filter((r): r is MessageRow => !!r)
    if (!rows.length) return { total: 0, transferred: 0, duplicates: 0, unavailable: 0, failed: 0, copy }
    if (new Set(rows.map((r) => r.account_id)).size !== 1) throw fail('CROSS_ACCOUNT', 'Správy sú z viacerých kont')
    const source = rows[0]!.account_id
    if (source === dest.account_id) throw fail('INVALID', 'Správy sú už v tomto konte')
    const target = await openTarget(ctx, dest.account_id)
    const run = new Run(ctx, rows.length, copy, dest.account_id)
    let error: unknown = null
    try {
      await run.folder(target, dest.path, rows.map((r) => r.id))
    } catch (e) {
      error = e
    } finally {
      await target.close()
    }
    if (!copy) toTrash(ctx, run.done)
    return finish(ctx, run, dest.account_id, error)
  })
}

/**
 * Priečinok aj s podpriečinkami do iného konta (pod priečinok targetParentId, alebo na najvyššiu úroveň).
 * Priečinok s rovnakým názvom v cieli sa použije (zlúči). Pri presune sa pôvodný priečinok odstráni
 * (správy do Koša) len vtedy, keď sa do cieľa dostali všetky jeho správy.
 */
export function transferFolder(ctx: TransferCtx, folderId: number, targetAccountId: number, targetParentId: number | null, copy: boolean): Promise<TransferSummary> {
  return exclusive(async () => {
    const src = ctx.store.folder(folderId)
    if (!src) throw fail('NO_TARGET', 'Priečinok neexistuje')
    if (src.account_id === targetAccountId) throw fail('INVALID', 'Priečinok je už v tomto konte')
    const parent = targetParentId === null ? null : ctx.store.folder(targetParentId)
    if (targetParentId !== null && (!parent || parent.account_id !== targetAccountId)) throw fail('NO_TARGET', 'Cieľový priečinok neexistuje')
    const rows = deletableSubtree(ctx.store, src.account_id, src.path) // Doručená pošta a špeciálne priečinky nie
    const meta = new Map(rows.map((r) => [r.path, r]))
    // Od najvyššej úrovne: nadradený priečinok v cieli vznikne skôr ako podpriečinky.
    const ordered = [...rows].sort((a, b) => depth(a.path, src.path) - depth(b.path, src.path))
    const ids = new Map(ordered.map((r) => [r.id, ctx.store.visibleMessageIds(r.id)]))
    const total = [...ids.values()].reduce((n, l) => n + l.length, 0)
    const target = await openTarget(ctx, targetAccountId)
    const run = new Run(ctx, total, copy, targetAccountId)
    let error: unknown = null
    try {
      const mapped = new Map<string, string>()
      for (const r of ordered) {
        const parentPath = r.path === src.path ? (parent?.path ?? null) : mapped.get(r.parent_path ?? '')
        if (parentPath === undefined) continue
        const path = await target.folder(parentPath, meta.get(r.path)!.name)
        mapped.set(r.path, path)
        await run.folder(target, path, ids.get(r.id) ?? [])
      }
    } catch (e) {
      error = e
    } finally {
      await target.close()
    }
    if (!copy) {
      const all = !error && run.done.length === total
      if (all) await ctx.sync.deleteFolder(folderId).catch((e) => log.warn('pôvodný priečinok sa nepodarilo odstrániť', { error: e }))
      else {
        run.summary.kept = true
        toTrash(ctx, run.done)
      }
    }
    return finish(ctx, run, targetAccountId, error)
  })
}

/** Pôvodné správy (už sú v cieli) do Koša pôvodného konta – hneď, bez čakania na „Vrátiť späť“. */
function toTrash(ctx: TransferCtx, ids: number[]): void {
  if (!ids.length) return
  try {
    ctx.sync.moveMessages(ids, { special: 'trash' }, 0)
  } catch (e) {
    log.warn('pôvodné správy sa nepodarilo presunúť do Koša', { error: e })
  }
}

function depth(path: string, root: string): number {
  return path === root ? 0 : path.length
}
