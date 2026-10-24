import type { Db } from './store/db'
import type { BlobStore } from './store/blobs'
import type { MailStore } from './store/mailstore'
import type { CoreEvents, CoreRequests, EventChannel, RequestChannel } from '../shared/ipc'
import type { Secrets } from './secrets'
import type { DiscoveryNet } from './providers/net'
import type { SyncManager } from './sync/manager'
import type { ExportManager } from './export/manager'
import type { ImportManager } from './import/manager'
import type { ArchiveManager } from './archive/archive'
import { buildView } from './view'
import { discover } from './providers/discover'
import { testConnection } from './mail/connection-test'
import { addAccount, getAccount, listAccounts, updateAccount, validateSettings } from './accounts'
import { removeAccount, updateServer } from './account-admin'
import { getSettings, setSettings } from './settings'
import { prepareCompose, resolveOutbox, sendCompose } from './compose-service'
import { prepareOpen, saveAllAttachments, saveAttachment } from './attachments'
import { discardDraft, flushDraft, saveDraft } from './drafts'
import { buildFtsQuery } from './search'
import type { FileGrants } from './files'
import { AiService } from './ai/service'
import type { FetchFn } from './ai/providers'
import { isArchiveId, isComposeMode } from '../shared/ipc'

export interface CoreContext {
  db: Db
  blobs: BlobStore
  store: MailStore
  sync: SyncManager
  exports: ExportManager
  imports: ImportManager
  archives: ArchiveManager
  files: FileGrants
  dataDir: string
  appVersion: string
  sqlite: string
  secrets: Secrets
  /** Heslá len do zatvorenia aplikácie. */
  sessionSecrets: Secrets
  net: DiscoveryNet
  emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
  /** Stiahnutie vzdialených obrázkov (v testoch sa dá nahradiť). */
  fetchRemote?: (urls: string[]) => Promise<Map<string, string>>
  /** Sieť pre AI (v testoch falošný server). */
  aiFetch?: FetchFn
}

export type Handlers = {
  [C in RequestChannel]: (data: CoreRequests[C][0]) => CoreRequests[C][1] | Promise<CoreRequests[C][1]>
}

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** ID správ kont (archív je len na čítanie – jeho záporné ID sa pri zmenách ignorujú). */
function ids(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0).slice(0, 10_000) : []
}

function searchScope(data: { folderId?: unknown; accountId?: unknown; archiveId?: unknown } | undefined): {
  folderId: number | null
  accountId: number | null
  archiveId: number | null
} {
  return {
    folderId: Number.isInteger(data?.folderId) ? (data!.folderId as number) : null,
    accountId: Number.isInteger(data?.accountId) ? (data!.accountId as number) : null,
    archiveId: Number.isInteger(data?.archiveId) && (data!.archiveId as number) > 0 ? (data!.archiveId as number) : null
  }
}

export function createHandlers(ctx: CoreContext): Handlers {
  const ai = new AiService({
    db: ctx.db,
    secrets: ctx.secrets,
    sessionSecrets: ctx.sessionSecrets,
    emit: (ch, data) => ctx.emit(ch, data),
    fetch: ctx.aiFetch,
    getMessage: (id) => Promise.resolve(handlers['messages.get']({ id }))
  })
  const handlers: Handlers = {
    'app.info': async () => ({
      version: ctx.appVersion,
      coreNode: process.versions.node,
      sqlite: ctx.sqlite,
      dataDir: ctx.dataDir,
      secureStorage: await ctx.secrets.available().catch(() => false)
    }),

    'accounts.list': () => listAccounts(ctx.db),

    'accounts.discover': (data) => discover(str(data?.email, 320), str(data?.displayName, 200), ctx.net),

    'accounts.test': async (data) => {
      const settings = validateSettings(data?.settings)
      return testConnection(settings, str(data?.password, 4096))
    },

    'accounts.add': async (data) => {
      const acc = await addAccount(ctx.db, ctx.secrets, ctx.sessionSecrets, data)
      ctx.emit('accounts.changed', null)
      ctx.sync.start(acc.id)
      return acc
    },

    'folders.list': () => ctx.store.listFolders(),

    'messages.list': (data) => {
      const folderId = data?.folderId === null ? null : Number.isInteger(data?.folderId) ? data.folderId : null
      const offset = Math.max(0, Math.floor(Number(data?.offset) || 0))
      const limit = Math.min(500, Math.max(1, Math.floor(Number(data?.limit) || 100)))
      if (isArchiveId(folderId)) return ctx.archives.listMessages(folderId!, offset, limit)
      return ctx.store.listMessages(folderId, offset, limit)
    },

    'messages.get': async (data) => {
      const id = Number(data?.id)
      const opts = { showRemote: !!data?.showRemote, alwaysForSender: !!data?.alwaysForSender }
      if (isArchiveId(id)) return ctx.archives.view(id, opts)
      let row = ctx.store.message(id)
      if (!row) throw err('NOT_FOUND', 'Správa neexistuje')
      if (!row.blob_sha256) {
        await ctx.sync.get(row.account_id)?.fetchBodyNow(id)
        row = ctx.store.message(id)
        if (!row?.blob_sha256) throw err('BODY_UNAVAILABLE', 'Obsah správy ešte nie je stiahnutý a server nie je dostupný')
      }
      const raw = ctx.blobs.read(row.blob_sha256)
      return buildView(ctx, raw, { id: row.id, accountId: row.account_id, subject: row.subject, date: row.internal_date, sender: row.from_addr }, opts)
    },

    'messages.setFlags': (data) => {
      const change: { seen?: boolean; flagged?: boolean } = {}
      if (typeof data?.seen === 'boolean') change.seen = data.seen
      if (typeof data?.flagged === 'boolean') change.flagged = data.flagged
      ctx.sync.setFlags(ids(data?.ids), change)
    },

    'sync.now': async (data) => {
      await ctx.sync.syncNow(Number.isInteger(data?.accountId) ? data?.accountId : undefined)
    },

    'sync.status': () => ctx.sync.statuses(),

    'sync.reconnect': () => ctx.sync.reconnectAll(),

    'compose.prepare': (data) => {
      const mode = isComposeMode(data?.mode) ? data.mode : 'new'
      return prepareCompose(ctx, mode, Number.isInteger(data?.messageId) ? data.messageId : undefined)
    },

    'compose.send': (data) => sendCompose(ctx, data),

    'outbox.list': () => ctx.store.outboxItems(),

    'outbox.resolve': (data) => {
      const action = data?.action === 'discard' ? 'discard' : data?.action === 'resend' ? 'resend' : null
      if (!action || !Number.isInteger(data?.id)) throw Object.assign(new Error('Neplatná požiadavka'), { code: 'INVALID' })
      resolveOutbox(ctx, data.id, action)
    },

    'export.start': async (data) => {
      const path = typeof data?.path === 'string' ? data.path : ''
      // Povolenie cesty prichádza od main procesu iným kanálom – chvíľu naň počkáme.
      for (let i = 0; i < 20 && !ctx.exports.isAllowed(path); i++) await new Promise((r) => setTimeout(r, 50))
      return ctx.exports.start(Number(data?.accountId), path)
    },

    'export.cancel': (data) => {
      if (Number.isInteger(data?.jobId)) ctx.exports.cancel(data.jobId)
    },

    'export.state': () => ctx.exports.state(),

    'import.peek': (data) => ctx.imports.peek(typeof data?.path === 'string' ? data.path : ''),
    'import.start': (data) => ctx.imports.start(data),
    'import.resume': async (data) => {
      if (!Number.isInteger(data?.jobId)) throw err('INVALID', 'Neplatná požiadavka')
      return ctx.imports.resume(data.jobId)
    },
    'import.cancel': (data) => {
      if (Number.isInteger(data?.jobId)) ctx.imports.cancel(data.jobId)
    },
    'import.discard': async (data) => {
      if (Number.isInteger(data?.jobId)) ctx.imports.discard(data.jobId)
    },
    'import.state': () => ctx.imports.state(),

    'archives.list': () => ctx.archives.list(),
    'archives.open': (data) => ctx.archives.open(typeof data?.path === 'string' ? data.path : ''),
    'archives.close': async (data) => {
      if (Number.isInteger(data?.archiveId)) await ctx.archives.close(data.archiveId)
    },

    'messages.move': (data) => {
      const special = data?.special === 'trash' || data?.special === 'archive' || data?.special === 'junk' || data?.special === 'inbox' ? data.special : undefined
      const folderId = Number.isInteger(data?.folderId) ? data.folderId : undefined
      if (!special && folderId === undefined) throw err('NO_TARGET', 'Chýba cieľ presunu')
      return ctx.sync.moveMessages(ids(data?.ids), { folderId, special })
    },

    'messages.deleteForever': (data) => ctx.sync.deleteForever(ids(data?.ids)),

    'attachments.save': (data) => saveAttachment(ctx, Number(data?.messageId), Number(data?.index), str(data?.path, 4096)),

    'attachments.saveAll': async (data) => ({ saved: await saveAllAttachments(ctx, Number(data?.messageId), str(data?.dir, 4096)) }),

    'attachments.prepareOpen': async (data) => ({ path: await prepareOpen(ctx, Number(data?.messageId), Number(data?.index)) }),

    'messages.search': (data) => {
      const fts = buildFtsQuery(str(data?.query, 500))
      if (!fts) return { total: 0, items: [], notDownloaded: 0 }
      const offset = Math.max(0, Math.floor(Number(data?.offset) || 0))
      const limit = Math.min(500, Math.max(1, Math.floor(Number(data?.limit) || 100)))
      const scope = searchScope(data)
      if (isArchiveId(scope.folderId) || scope.archiveId !== null) return ctx.archives.search(fts, scope, offset, limit)
      return ctx.store.searchMessages(fts, scope, offset, limit)
    },

    'messages.searchIds': (data) => {
      const fts = buildFtsQuery(str(data?.query, 500))
      if (!fts) return []
      const scope = searchScope(data)
      if (isArchiveId(scope.folderId) || scope.archiveId !== null) return ctx.archives.searchIds(fts, scope)
      return ctx.store.searchIds(fts, scope)
    },

    'accounts.get': async (data) => getAccount(ctx.db, Number(data?.id)),

    'accounts.update': async (data) => {
      const r = updateAccount(ctx.db, Number(data?.id), data?.patch ?? {})
      ctx.emit('accounts.changed', null)
      return r
    },

    'accounts.updateServer': (data) => updateServer(ctx, Number(data?.id), data),

    'accounts.remove': (data) => removeAccount(ctx, Number(data?.id)),

    'addresses.suggest': (data) => ctx.store.suggestAddresses(str(data?.query, 200), Math.min(20, Math.max(1, Number(data?.limit) || 8))),

    'settings.get': () => getSettings(ctx.db),

    'settings.set': (data) => setSettings(ctx.db, data ?? {}),

    'drafts.save': (data) => saveDraft(ctx, data),

    'drafts.discard': (data) => {
      if (Number.isInteger(data?.draftId)) discardDraft(ctx, data.draftId)
    },

    'drafts.flush': (data) => {
      if (Number.isInteger(data?.draftId)) flushDraft(ctx, data.draftId)
    },

    'messages.undo': (data) => ctx.sync.undo(ids(data?.undo)),

    'messages.listIds': (data) => {
      const folderId = Number.isInteger(data?.folderId) ? (data!.folderId as number) : null
      return isArchiveId(folderId) ? ctx.archives.listIds(folderId!) : ctx.store.listIds(folderId)
    },

    'folders.create': async (data) => {
      const parentId = Number.isInteger(data?.parentId) ? (data!.parentId as number) : null
      return { folderId: await ctx.sync.createFolder(Number(data?.accountId), parentId, str(data?.name, 300)) }
    },

    'ai.config.get': () => ai.getConfig(),
    'ai.config.set': (data) => ai.setConfig(data ?? {}),
    'ai.models': (data) => ai.models(data),
    'ai.run': (data) => ai.run(data),
    'ai.cancel': (data) => ai.cancel(data?.requestId)
  }
  return handlers
}
