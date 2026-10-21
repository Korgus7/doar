import type { Db } from './store/db'
import type { BlobStore } from './store/blobs'
import type { MailStore } from './store/mailstore'
import type { CoreEvents, CoreRequests, EventChannel, MessageView, RequestChannel } from '../shared/ipc'
import type { Secrets } from './secrets'
import type { DiscoveryNet } from './providers/net'
import type { SyncManager } from './sync/manager'
import type { ExportManager } from './export/manager'
import { discover } from './providers/discover'
import { testConnection } from './mail/connection-test'
import { renderMessage } from './mail/parse'
import { fetchRemoteImages } from './mail/remote'
import { addAccount, listAccounts, validateSettings } from './accounts'
import { prepareCompose, resolveOutbox, sendCompose } from './compose-service'

export interface CoreContext {
  db: Db
  blobs: BlobStore
  store: MailStore
  sync: SyncManager
  exports: ExportManager
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

function ids(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)).slice(0, 10_000) : []
}

export function createHandlers(ctx: CoreContext): Handlers {
  return {
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
      return ctx.store.listMessages(folderId, offset, limit)
    },

    'messages.get': async (data) => {
      const id = Number(data?.id)
      let row = ctx.store.message(id)
      if (!row) throw err('NOT_FOUND', 'Správa neexistuje')
      if (!row.blob_sha256) {
        await ctx.sync.get(row.account_id)?.fetchBodyNow(id)
        row = ctx.store.message(id)
        if (!row?.blob_sha256) throw err('BODY_UNAVAILABLE', 'Obsah správy ešte nie je stiahnutý a server nie je dostupný')
      }
      const sender = row.from_addr.toLowerCase()
      if (data?.alwaysForSender && sender) {
        ctx.db.prepare('INSERT OR IGNORE INTO remote_content_allow(sender) VALUES (?)').run(sender)
      }
      const senderAllowed = !!sender && !!ctx.db.prepare('SELECT 1 FROM remote_content_allow WHERE sender = ?').get(sender)
      const raw = ctx.blobs.read(row.blob_sha256)
      let r = await renderMessage(raw, null)
      let remoteShown = false
      if ((data?.showRemote || senderAllowed) && r.remoteUrls.length) {
        const map = await (ctx.fetchRemote ?? fetchRemoteImages)(r.remoteUrls)
        r = await renderMessage(raw, map)
        remoteShown = true
      }
      const view: MessageView = {
        id: row.id,
        accountId: row.account_id,
        subject: r.subject || row.subject,
        from: r.from,
        to: r.to,
        cc: r.cc,
        replyTo: r.replyTo,
        date: r.date ?? row.internal_date,
        html: r.html,
        text: r.text,
        attachments: r.attachments,
        remoteBlocked: r.remoteBlocked,
        remoteShown,
        senderAllowed
      }
      return view
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

    'compose.prepare': (data) => {
      const mode = data?.mode === 'reply' || data?.mode === 'replyAll' ? data.mode : 'new'
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

    'export.state': () => ctx.exports.state()
  }
}
