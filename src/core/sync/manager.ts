import type { Db } from '../store/db'
import type { BlobStore } from '../store/blobs'
import type { MailStore } from '../store/mailstore'
import type { Secrets } from '../secrets'
import { passwordKey } from '../secrets'
import type { CoreEvents, EventChannel, SyncStatus } from '../../shared/ipc'
import type { ImapFlow } from 'imapflow'
import { AccountSync, type AccountRow, type SyncDeps } from './account-sync'
import { createImapClient } from '../mail/imap'

/** Spravuje synchronizáciu všetkých kont. */
export class SyncManager {
  private syncs = new Map<number, AccountSync>()
  private deps: SyncDeps

  constructor(opts: {
    db: Db
    store: MailStore
    blobs: BlobStore
    secrets: Secrets
    sessionSecrets: Secrets
    emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
    clientFactory?: SyncDeps['clientFactory']
    smtpSend?: SyncDeps['smtpSend']
  }) {
    this.deps = {
      db: opts.db,
      store: opts.store,
      blobs: opts.blobs,
      emit: opts.emit,
      clientFactory: opts.clientFactory,
      smtpSend: opts.smtpSend,
      getPassword: (acc) => (acc.password_storage === 'session' ? opts.sessionSecrets : opts.secrets).get(passwordKey(acc.id))
    }
  }

  private accountRow(id: number): AccountRow | null {
    return (this.deps.db
      .prepare(
        'SELECT id, email, username, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, save_sent_copy, display_name, password_storage FROM accounts WHERE id = ?'
      )
      .get(id) as unknown as AccountRow | undefined) ?? null
  }

  /**
   * Nové (nepripojené) IMAP spojenie pre konto – pre dlhé úlohy mimo synchronizácie (export),
   * aby neblokovali čítanie a synchronizáciu.
   */
  async newImapClient(accountId: number): Promise<ImapFlow> {
    const row = this.accountRow(accountId)
    if (!row) throw Object.assign(new Error('Konto neexistuje'), { code: 'NO_ACCOUNT' })
    const pass = await this.deps.getPassword(row)
    if (!pass) throw Object.assign(new Error('Chýba heslo'), { code: 'PASSWORD_REQUIRED' })
    return this.deps.clientFactory
      ? this.deps.clientFactory(row, pass, false)
      : createImapClient({ host: row.imap_host, port: row.imap_port, security: row.imap_security }, row.username, pass)
  }

  startAll(): void {
    // Odosielanie prerušené pádom aplikácie: nevieme, či správa odišla → rozhodne používateľ.
    this.deps.store.recoverInterruptedSends()
    const ids = (this.deps.db.prepare('SELECT id FROM accounts ORDER BY sort_order, id').all() as { id: number }[]).map((r) => r.id)
    for (const id of ids) this.start(id)
  }

  start(accountId: number): void {
    if (this.syncs.has(accountId)) return
    const row = this.accountRow(accountId)
    if (!row) return
    const s = new AccountSync(row, this.deps)
    this.syncs.set(accountId, s)
    s.start()
  }

  async stop(accountId: number): Promise<void> {
    const s = this.syncs.get(accountId)
    this.syncs.delete(accountId)
    await s?.stop()
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.syncs.keys()].map((id) => this.stop(id)))
  }

  get(accountId: number): AccountSync | undefined {
    return this.syncs.get(accountId)
  }

  statuses(): SyncStatus[] {
    return [...this.syncs.values()].map((s) => s.status)
  }

  async syncNow(accountId?: number): Promise<void> {
    const list = accountId === undefined ? [...this.syncs.values()] : [this.syncs.get(accountId)].filter((s): s is AccountSync => !!s)
    await Promise.allSettled(list.map((s) => s.requestSync()))
  }

  /**
   * Zmena príznakov (prečítané, hviezdička): hneď lokálne, potom na server cez frontu operácií.
   * Ak server práve nie je dostupný, zmena počká a odošle sa pri ďalšej synchronizácii.
   */
  setFlags(ids: number[], change: { seen?: boolean; flagged?: boolean }): void {
    const store = this.deps.store
    const rows = store.setLocalFlags(ids, change)
    const groups = new Map<string, { accountId: number; folderId: number; uids: number[]; messageIds: number[] }>()
    for (const r of rows) {
      const key = `${r.account_id}:${r.folder_id}`
      const g = groups.get(key) ?? { accountId: r.account_id, folderId: r.folder_id, uids: [], messageIds: [] }
      g.uids.push(r.uid)
      g.messageIds.push(r.id)
      groups.set(key, g)
    }
    const add: string[] = []
    const remove: string[] = []
    if (change.seen !== undefined) (change.seen ? add : remove).push('\\Seen')
    if (change.flagged !== undefined) (change.flagged ? add : remove).push('\\Flagged')
    const touched = new Set<number>()
    for (const g of groups.values()) {
      store.enqueueOperation(g.accountId, 'flags', { folderId: g.folderId, uids: g.uids, messageIds: g.messageIds, add, remove })
      touched.add(g.accountId)
    }
    this.deps.emit('messages.changed', { folderIds: [...new Set(rows.map((r) => r.folder_id))] })
    for (const id of touched) void this.syncs.get(id)?.pushOperations().catch(() => {})
  }
}
