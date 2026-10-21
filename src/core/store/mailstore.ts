import type { Db } from './db'
import type { FolderItem, MessageListItem, OutboxItem, OutboxState, SpecialUse } from '../../shared/ipc'

/**
 * Prístup k priečinkom a správam v lokálnej databáze. Žiadna sieť – to rieši `sync`.
 */

export interface FolderInfo {
  path: string
  delimiter: string | null
  name: string
  parentPath: string | null
  specialUse: SpecialUse | null
  specialUseSource: 'server' | 'name' | null
  selectable: boolean
  subscribed: boolean
}

export interface FolderRow {
  id: number
  account_id: number
  path: string
  special_use: SpecialUse | null
  uidvalidity: number | null
  uidnext: number | null
  highestmodseq: string | null
  total_count: number
  selectable: number
}

export interface HeaderInput {
  uid: number
  size: number
  internalDate: string | null
  dateHeader: string | null
  messageId: string | null
  inReplyTo: string | null
  subject: string
  fromAddr: string
  fromName: string
  to: { name: string; address: string }[]
  cc: { name: string; address: string }[]
  flags: Set<string>
}

export interface Flags {
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  keywords: string[]
}

export function flagsFromSet(set: Set<string> | undefined): Flags {
  const s = set ?? new Set<string>()
  return {
    seen: s.has('\\Seen'),
    flagged: s.has('\\Flagged'),
    answered: s.has('\\Answered'),
    draft: s.has('\\Draft'),
    keywords: [...s].filter((f) => !f.startsWith('\\')).sort()
  }
}

const SPECIAL_ORDER: Record<string, number> = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5 }

export class MailStore {
  constructor(private readonly db: Db) {}

  // ---------- priečinky ----------

  /** Zosúladí zoznam priečinkov so serverom. Priečinky, ktoré na serveri už nie sú, sa lokálne odstránia. */
  syncFolders(accountId: number, folders: FolderInfo[]): void {
    const db = this.db
    db.exec('BEGIN')
    try {
      const existing = new Map(
        (db.prepare('SELECT id, path, special_use_source FROM folders WHERE account_id = ?').all(accountId) as unknown as { id: number; path: string; special_use_source: string | null }[]).map((r) => [r.path, r])
      )
      const upsert = db.prepare(`INSERT INTO folders (account_id, path, delimiter, name, parent_path, special_use, special_use_source, selectable, subscribed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, path) DO UPDATE SET delimiter = excluded.delimiter, name = excluded.name, parent_path = excluded.parent_path,
          selectable = excluded.selectable, subscribed = excluded.subscribed,
          special_use = CASE WHEN folders.special_use_source = 'user' THEN folders.special_use ELSE excluded.special_use END,
          special_use_source = CASE WHEN folders.special_use_source = 'user' THEN 'user' ELSE excluded.special_use_source END`)
      for (const f of folders) {
        upsert.run(accountId, f.path, f.delimiter, f.name, f.parentPath, f.specialUse, f.specialUseSource, f.selectable ? 1 : 0, f.subscribed ? 1 : 0)
        existing.delete(f.path)
      }
      const del = db.prepare('DELETE FROM folders WHERE id = ?')
      for (const r of existing.values()) del.run(r.id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  folderRows(accountId: number): FolderRow[] {
    return this.db
      .prepare('SELECT id, account_id, path, special_use, uidvalidity, uidnext, highestmodseq, total_count, selectable FROM folders WHERE account_id = ?')
      .all(accountId) as unknown as FolderRow[]
  }

  folder(id: number): FolderRow | null {
    return (this.db
      .prepare('SELECT id, account_id, path, special_use, uidvalidity, uidnext, highestmodseq, total_count, selectable FROM folders WHERE id = ?')
      .get(id) as unknown as FolderRow | undefined) ?? null
  }

  /** Priečinky pre rozhranie: špeciálne v pevnom poradí, ostatné abecedne podľa cesty. */
  listFolders(accountId?: number): FolderItem[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.account_id AS accountId, f.path, f.name, f.parent_path AS parentPath, f.special_use AS specialUse, f.selectable,
                f.total_count AS total, f.synced_bodies_count AS syncedBodies, f.delimiter,
                (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.seen = 0) AS unread,
                (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id) AS localCount
         FROM folders f ${accountId === undefined ? '' : 'WHERE f.account_id = ?'}`
      )
      .all(...(accountId === undefined ? [] : [accountId])) as unknown as (Omit<FolderItem, 'selectable' | 'depth'> & { selectable: number; delimiter: string | null })[]
    const items = rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      path: r.path,
      name: r.name,
      parentPath: r.parentPath,
      specialUse: r.specialUse,
      selectable: !!r.selectable,
      unread: r.unread,
      total: r.total,
      localCount: r.localCount,
      depth: r.parentPath ? r.path.split(r.delimiter ?? '/').length - 1 : 0
    }))
    return items.sort(
      (a, b) =>
        a.accountId - b.accountId ||
        (SPECIAL_ORDER[a.specialUse ?? ''] ?? 10) - (SPECIAL_ORDER[b.specialUse ?? ''] ?? 10) ||
        a.path.localeCompare(b.path, 'sk')
    )
  }

  /** Zmena UIDVALIDITY: všetky lokálne záznamy priečinka sú neplatné. Originály (.eml) ostávajú. */
  resetFolder(folderId: number, uidvalidity: number): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM messages WHERE folder_id = ?').run(folderId)
      this.db.prepare('UPDATE folders SET uidvalidity = ?, uidnext = NULL, highestmodseq = NULL, synced_headers_upto = 0, synced_bodies_count = 0 WHERE id = ?').run(uidvalidity, folderId)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  updateFolderState(folderId: number, s: { uidvalidity: number; uidnext: number; highestmodseq: string | null; total: number }): void {
    this.db
      .prepare(
        `UPDATE folders SET uidvalidity = ?, uidnext = ?, highestmodseq = ?, total_count = ?, last_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           synced_bodies_count = (SELECT COUNT(*) FROM messages WHERE folder_id = folders.id AND blob_sha256 IS NOT NULL)
         WHERE id = ?`
      )
      .run(s.uidvalidity, s.uidnext, s.highestmodseq, s.total, folderId)
  }

  // ---------- správy ----------

  localUids(folderId: number): Set<number> {
    return new Set((this.db.prepare('SELECT uid FROM messages WHERE folder_id = ?').all(folderId) as { uid: number }[]).map((r) => r.uid))
  }

  maxUid(folderId: number): number {
    return (this.db.prepare('SELECT COALESCE(MAX(uid), 0) AS m FROM messages WHERE folder_id = ?').get(folderId) as { m: number }).m
  }

  /** Vloží hlavičky nových správ (existujúce preskočí) a zaindexuje ich pre vyhľadávanie. */
  insertHeaders(accountId: number, folderId: number, list: HeaderInput[]): number {
    if (!list.length) return 0
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO messages (account_id, folder_id, uid, size, internal_date, date_header, message_id, in_reply_to, subject,
         from_addr, from_name, to_json, cc_json, seen, flagged, answered, draft, keywords_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    const fts = this.db.prepare('INSERT INTO messages_fts(rowid, subject, from_text, to_text, body_text) VALUES (?, ?, ?, ?, ?)')
    let added = 0
    this.db.exec('BEGIN')
    try {
      for (const h of list) {
        const f = flagsFromSet(h.flags)
        const row = ins.get(
          accountId,
          folderId,
          h.uid,
          h.size,
          h.internalDate,
          h.dateHeader,
          h.messageId,
          h.inReplyTo,
          h.subject,
          h.fromAddr,
          h.fromName,
          JSON.stringify(h.to),
          JSON.stringify(h.cc),
          f.seen ? 1 : 0,
          f.flagged ? 1 : 0,
          f.answered ? 1 : 0,
          f.draft ? 1 : 0,
          JSON.stringify(f.keywords)
        ) as { id: number } | undefined
        if (!row) continue
        added++
        fts.run(row.id, h.subject, `${h.fromName} ${h.fromAddr}`, [...h.to, ...h.cc].map((a) => `${a.name} ${a.address}`).join(' '), '')
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return added
  }

  /** Príznaky zo servera. Správy s neodoslanou lokálnou zmenou sa preskočia (lokálna zmena má prednosť). */
  applyServerFlags(folderId: number, list: { uid: number; flags: Set<string> }[]): number[] {
    const upd = this.db.prepare(
      `UPDATE messages SET seen = ?, flagged = ?, answered = ?, draft = ?, keywords_json = ?
       WHERE folder_id = ? AND uid = ? AND local_state = 'synced'
         AND (seen != ? OR flagged != ? OR answered != ? OR draft != ? OR keywords_json != ?) RETURNING id`
    )
    const changed: number[] = []
    this.db.exec('BEGIN')
    try {
      for (const m of list) {
        const f = flagsFromSet(m.flags)
        const v = [f.seen ? 1 : 0, f.flagged ? 1 : 0, f.answered ? 1 : 0, f.draft ? 1 : 0, JSON.stringify(f.keywords)] as const
        const r = upd.get(...v, folderId, m.uid, ...v) as { id: number } | undefined
        if (r) changed.push(r.id)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return changed
  }

  /** Odstráni lokálne záznamy správ, ktoré na serveri už nie sú (zmazané inde). */
  removeMissing(folderId: number, serverUids: Set<number>): number {
    const gone = [...this.localUids(folderId)].filter((u) => !serverUids.has(u))
    if (!gone.length) return 0
    const del = this.db.prepare('DELETE FROM messages WHERE folder_id = ? AND uid = ?')
    this.db.exec('BEGIN')
    try {
      for (const u of gone) del.run(folderId, u)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return gone.length
  }

  /** Správy, ktorým chýba originál – od najnovších. */
  needingBodies(accountId: number, limit: number): { id: number; folderId: number; uid: number; size: number }[] {
    return this.db
      .prepare(
        `SELECT m.id, m.folder_id AS folderId, m.uid, m.size FROM messages m
         WHERE m.account_id = ? AND m.blob_sha256 IS NULL ORDER BY m.internal_date DESC LIMIT ?`
      )
      .all(accountId, limit) as unknown as { id: number; folderId: number; uid: number; size: number }[]
  }

  countNeedingBodies(accountId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE account_id = ? AND blob_sha256 IS NULL').get(accountId) as { c: number }).c
  }

  /** Uloží odkaz na stiahnutý originál a doplní fulltext. */
  setBody(id: number, sha: string, info: { snippet: string; hasAttachments: boolean; bodyText: string }): void {
    const m = this.db.prepare('SELECT subject, from_name, from_addr, to_json, cc_json FROM messages WHERE id = ?').get(id) as
      | { subject: string; from_name: string; from_addr: string; to_json: string; cc_json: string }
      | undefined
    if (!m) return
    const to = [...(JSON.parse(m.to_json) as { name: string; address: string }[]), ...(JSON.parse(m.cc_json) as { name: string; address: string }[])]
    this.db.exec('BEGIN')
    try {
      this.db.prepare('UPDATE messages SET blob_sha256 = ?, snippet = ?, has_attachments = ? WHERE id = ?').run(sha, info.snippet, info.hasAttachments ? 1 : 0, id)
      this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id)
      this.db
        .prepare('INSERT INTO messages_fts(rowid, subject, from_text, to_text, body_text) VALUES (?, ?, ?, ?, ?)')
        .run(id, m.subject, `${m.from_name} ${m.from_addr}`, to.map((a) => `${a.name} ${a.address}`).join(' '), info.bodyText.slice(0, 200_000))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  message(id: number): MessageRow | null {
    return (this.db
      .prepare(
        `SELECT m.*, f.path AS folder_path, a.email AS account_email FROM messages m
         JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id WHERE m.id = ?`
      )
      .get(id) as unknown as MessageRow | undefined) ?? null
  }

  /** Zoznam správ priečinka alebo spoločnej doručenej pošty (folderId = null), od najnovších. */
  listMessages(folderId: number | null, offset: number, limit: number): { total: number; items: MessageListItem[] } {
    const where = folderId === null ? `f.special_use = 'inbox'` : 'm.folder_id = ?'
    const args = folderId === null ? [] : [folderId]
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM messages m JOIN folders f ON f.id = m.folder_id WHERE ${where}`).get(...args) as { c: number }).c
    const items = this.db
      .prepare(
        `SELECT m.id, m.account_id AS accountId, m.folder_id AS folderId, m.subject, m.from_name AS fromName, m.from_addr AS fromAddr,
                m.to_json AS toJson, COALESCE(m.internal_date, m.date_header) AS date, m.seen, m.flagged, m.answered,
                m.has_attachments AS hasAttachments, m.snippet, m.local_state AS localState, m.blob_sha256 IS NOT NULL AS downloaded,
                a.color AS accountColor, a.name AS accountName
         FROM messages m JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id
         WHERE ${where} ORDER BY COALESCE(m.internal_date, m.date_header) DESC, m.id DESC LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset) as unknown as (Omit<MessageListItem, 'seen' | 'flagged' | 'answered' | 'hasAttachments' | 'downloaded' | 'to'> & {
      seen: number
      flagged: number
      answered: number
      hasAttachments: number
      downloaded: number
      toJson: string
    })[]
    return {
      total,
      items: items.map(({ toJson, ...r }) => ({
        ...r,
        to: (JSON.parse(toJson) as { name: string; address: string }[]).map((a) => a.name || a.address),
        seen: !!r.seen,
        flagged: !!r.flagged,
        answered: !!r.answered,
        hasAttachments: !!r.hasAttachments,
        downloaded: !!r.downloaded
      }))
    }
  }

  /** Lokálna zmena príznakov – hneď viditeľná, na server ide cez frontu operácií. */
  setLocalFlags(ids: number[], change: { seen?: boolean; flagged?: boolean }): MessageRow[] {
    const changed: MessageRow[] = []
    this.db.exec('BEGIN')
    try {
      for (const id of ids) {
        const sets: string[] = []
        const vals: number[] = []
        if (change.seen !== undefined) sets.push('seen = ?'), vals.push(change.seen ? 1 : 0)
        if (change.flagged !== undefined) sets.push('flagged = ?'), vals.push(change.flagged ? 1 : 0)
        if (!sets.length) continue
        const r = this.db.prepare(`UPDATE messages SET ${sets.join(', ')}, local_state = 'pending' WHERE id = ? RETURNING id`).get(...vals, id)
        if (r) changed.push(this.message(id)!)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return changed
  }

  setLocalState(ids: number[], state: 'synced' | 'pending' | 'failed'): void {
    const st = this.db.prepare('UPDATE messages SET local_state = ? WHERE id = ?')
    for (const id of ids) st.run(state, id)
  }

  /** Priečinok založený Doarom (napr. chýbajúce Odoslané) – funkciu určil používateľ/aplikácia. */
  markSpecialUse(accountId: number, path: string, use: SpecialUse): void {
    this.db.prepare(`INSERT INTO folders (account_id, path, name, special_use, special_use_source) VALUES (?, ?, ?, ?, 'user')
      ON CONFLICT(account_id, path) DO UPDATE SET special_use = excluded.special_use, special_use_source = 'user'`).run(accountId, path, path.split('/').pop() ?? path, use)
  }

  // ---------- odosielacia fronta ----------

  addOutbox(o: { accountId: number; sha: string; messageId: string; subject: string; recipients: string[]; replyTo: number | null; saveCopy: boolean }): number {
    return (this.db
      .prepare(
        `INSERT INTO outbox (account_id, blob_sha256, message_id, state, sent_copy_state, subject, recipients_json, reply_to_message)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?) RETURNING id`
      )
      .get(o.accountId, o.sha, o.messageId, o.saveCopy ? 'pending' : 'not_needed', o.subject, JSON.stringify(o.recipients), o.replyTo) as { id: number }).id
  }

  outboxRows(accountId?: number): OutboxRow[] {
    return this.db
      .prepare(`SELECT * FROM outbox ${accountId === undefined ? '' : 'WHERE account_id = ?'} ORDER BY id`)
      .all(...(accountId === undefined ? [] : [accountId])) as unknown as OutboxRow[]
  }

  outboxRow(id: number): OutboxRow | null {
    return (this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as unknown as OutboxRow | undefined) ?? null
  }

  setOutbox(id: number, patch: { state?: OutboxState; sentCopyState?: OutboxRow['sent_copy_state']; smtpResponse?: string | null; error?: string | null; attempt?: boolean }): void {
    const sets: string[] = [`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`]
    const vals: (string | number | null)[] = []
    if (patch.state !== undefined) sets.push('state = ?'), vals.push(patch.state)
    if (patch.sentCopyState !== undefined) sets.push('sent_copy_state = ?'), vals.push(patch.sentCopyState)
    if (patch.smtpResponse !== undefined) sets.push('smtp_response = ?'), vals.push(patch.smtpResponse)
    if (patch.error !== undefined) sets.push('error = ?'), vals.push(patch.error)
    if (patch.attempt) sets.push('attempts = attempts + 1')
    this.db.prepare(`UPDATE outbox SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  deleteOutbox(id: number): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id)
  }

  /** Po páde aplikácie počas odosielania nevieme, či správa odišla → nejasný výsledok, nie automatické opakovanie. */
  recoverInterruptedSends(): number {
    return Number(this.db.prepare(`UPDATE outbox SET state = 'uncertain', error = 'INTERRUPTED' WHERE state = 'sending'`).run().changes)
  }

  outboxItems(): OutboxItem[] {
    return (this.db
      .prepare(`SELECT o.*, a.email AS account_email FROM outbox o JOIN accounts a ON a.id = o.account_id WHERE o.state != 'sent' OR o.sent_copy_state IN ('pending','failed') ORDER BY o.id`)
      .all() as unknown as (OutboxRow & { account_email: string })[]).map((r) => ({
      id: r.id,
      accountId: r.account_id,
      accountEmail: r.account_email,
      subject: r.subject,
      recipients: JSON.parse(r.recipients_json) as string[],
      state: r.state,
      sentCopyState: r.sent_copy_state,
      error: r.error,
      createdAt: r.created_at
    }))
  }

  rememberAddresses(list: { name: string; address: string }[]): void {
    const st = this.db.prepare(`INSERT INTO addresses (email, name, use_count, last_used) VALUES (lower(?), ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(email) DO UPDATE SET use_count = use_count + 1, last_used = excluded.last_used, name = CASE WHEN excluded.name != '' THEN excluded.name ELSE addresses.name END`)
    for (const a of list) st.run(a.address, a.name)
  }

  // ---------- fronta operácií ----------

  enqueueOperation(accountId: number, kind: string, payload: unknown): number {
    return (this.db.prepare('INSERT INTO operations (account_id, kind, payload_json) VALUES (?, ?, ?) RETURNING id').get(accountId, kind, JSON.stringify(payload)) as { id: number }).id
  }

  pendingOperations(accountId: number): { id: number; kind: string; payload: unknown; attempts: number }[] {
    return (this.db
      .prepare(`SELECT id, kind, payload_json, attempts FROM operations WHERE account_id = ? AND state IN ('pending','failed') ORDER BY id`)
      .all(accountId) as unknown as { id: number; kind: string; payload_json: string; attempts: number }[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      payload: JSON.parse(r.payload_json),
      attempts: r.attempts
    }))
  }

  finishOperation(id: number, ok: boolean, error?: string): void {
    this.db
      .prepare(`UPDATE operations SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(ok ? 'done' : 'failed', error ?? null, id)
  }
}

export interface MessageRow {
  id: number
  account_id: number
  folder_id: number
  uid: number
  blob_sha256: string | null
  size: number
  internal_date: string | null
  date_header: string | null
  message_id: string | null
  subject: string
  from_addr: string
  from_name: string
  to_json: string
  cc_json: string
  seen: number
  flagged: number
  answered: number
  local_state: string
  folder_path: string
  account_email: string
}

export interface OutboxRow {
  id: number
  account_id: number
  blob_sha256: string
  message_id: string
  state: OutboxState
  sent_copy_state: 'not_needed' | 'pending' | 'done' | 'failed'
  smtp_response: string | null
  error: string | null
  subject: string
  recipients_json: string
  reply_to_message: number | null
  attempts: number
  created_at: string
}
