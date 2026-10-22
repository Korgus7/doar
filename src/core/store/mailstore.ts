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
                (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.seen = 0 AND m.hidden = 0) AS unread,
                (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.hidden = 0) AS localCount
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
    const where = `${folderId === null ? `f.special_use = 'inbox'` : 'm.folder_id = ?'} AND m.hidden = 0`
    return this.queryList(where, folderId === null ? [] : [folderId], offset, limit)
  }

  /**
   * Vyhľadávanie vo fulltexte (dotaz FTS5 zo `search.ts`). Rozsah: priečinok, konto alebo všetko.
   * Vráti aj počet správ v rozsahu, ktorých text ešte nie je stiahnutý (hľadá sa v nich len v hlavičkách).
   */
  searchMessages(
    fts: string,
    scope: { folderId?: number | null; accountId?: number | null },
    offset: number,
    limit: number
  ): { total: number; items: MessageListItem[]; notDownloaded: number } {
    const { where, args } = this.searchWhere(fts, scope)
    const r = this.queryList(where, args, offset, limit)
    const scopeOnly = this.scopeWhere(scope)
    const notDownloaded = (this.db
      .prepare(`SELECT COUNT(*) AS c FROM messages m JOIN folders f ON f.id = m.folder_id WHERE ${scopeOnly.where} AND m.blob_sha256 IS NULL`)
      .get(...scopeOnly.args) as { c: number }).c
    return { ...r, notDownloaded }
  }

  searchIds(fts: string, scope: { folderId?: number | null; accountId?: number | null }): number[] {
    const { where, args } = this.searchWhere(fts, scope)
    return (this.db
      .prepare(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE ${where} ORDER BY COALESCE(m.internal_date, m.date_header) DESC, m.id DESC`)
      .all(...args) as { id: number }[]).map((r) => r.id)
  }

  private scopeWhere(scope: { folderId?: number | null; accountId?: number | null }): { where: string; args: (string | number)[] } {
    const parts = ['m.hidden = 0']
    const args: (string | number)[] = []
    if (scope.folderId != null) {
      parts.push('m.folder_id = ?')
      args.push(scope.folderId)
    } else if (scope.accountId != null) {
      parts.push('m.account_id = ?')
      args.push(scope.accountId)
    }
    return { where: parts.join(' AND '), args }
  }

  private searchWhere(fts: string, scope: { folderId?: number | null; accountId?: number | null }): { where: string; args: (string | number)[] } {
    const s = this.scopeWhere(scope)
    return { where: `${s.where} AND m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`, args: [...s.args, fts] }
  }

  private queryList(where: string, args: (string | number)[], offset: number, limit: number): { total: number; items: MessageListItem[] } {
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

  /** Mená adresátov z písania (počet použití sa zvýši až po odoslaní). */
  rememberNames(list: { name: string; address: string }[]): void {
    const st = this.db.prepare(`INSERT INTO addresses (email, name, use_count, last_used) VALUES (lower(?), ?, 0, NULL)
      ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE addresses.name END`)
    for (const a of list) st.run(a.address, a.name)
  }

  /**
   * Návrhy adries: najprv tie, na ktoré používateľ písal (podľa počtu a času), potom odosielatelia doručenej pošty.
   * Hľadá sa od začiatku slova v mene alebo adrese, bez ohľadu na diakritiku.
   */
  suggestAddresses(query: string, limit: number): { name: string; address: string }[] {
    const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    const q = fold(query.trim())
    if (!q) return []
    const words = (s: string): string[] => fold(s).split(/[\s.@_<>"',-]+/).filter(Boolean)
    const hit = (name: string, address: string): boolean => fold(address).startsWith(q) || [...words(name), ...words(address)].some((w) => w.startsWith(q)) || fold(name).startsWith(q)
    const out = new Map<string, { name: string; address: string }>()
    const sent = this.db
      .prepare(`SELECT email AS address, name FROM addresses ORDER BY use_count DESC, last_used DESC LIMIT 5000`)
      .all() as { address: string; name: string }[]
    for (const r of sent) if (hit(r.name, r.address) && !out.has(r.address)) out.set(r.address, r)
    if (out.size < limit) {
      // Odosielatelia doručenej pošty, najčastejší najprv (diakritiku a začiatky slov rieši `hit`).
      const rows = this.db
        .prepare(
          `SELECT lower(from_addr) AS address, MAX(from_name) AS name, COUNT(*) AS c FROM messages
           WHERE from_addr != '' GROUP BY lower(from_addr) ORDER BY c DESC LIMIT 5000`
        )
        .all() as { address: string; name: string | null }[]
      for (const r of rows) if (hit(r.name ?? '', r.address) && !out.has(r.address)) out.set(r.address, { name: r.name ?? '', address: r.address })
    }
    return [...out.values()].slice(0, limit)
  }

  rememberAddresses(list: { name: string; address: string }[]): void {
    const st = this.db.prepare(`INSERT INTO addresses (email, name, use_count, last_used) VALUES (lower(?), ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(email) DO UPDATE SET use_count = use_count + 1, last_used = excluded.last_used, name = CASE WHEN excluded.name != '' THEN excluded.name ELSE addresses.name END`)
    for (const a of list) st.run(a.address, a.name)
  }

  // ---------- fronta operácií ----------

  enqueueOperation(accountId: number, kind: string, payload: unknown, notBefore?: Date): number {
    return (this.db
      .prepare('INSERT INTO operations (account_id, kind, payload_json, not_before) VALUES (?, ?, ?, ?) RETURNING id')
      .get(accountId, kind, JSON.stringify(payload), notBefore ? notBefore.toISOString() : null) as { id: number }).id
  }

  /** Operácie pripravené na vykonanie (bez tých, ktoré ešte čakajú na uplynutie času na „Vrátiť späť“). */
  pendingOperations(accountId: number): { id: number; kind: string; payload: unknown; attempts: number }[] {
    return (this.db
      .prepare(
        `SELECT id, kind, payload_json, attempts FROM operations
         WHERE account_id = ? AND state IN ('pending','failed') AND attempts < 3
           AND (not_before IS NULL OR not_before <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ORDER BY id`
      )
      .all(accountId) as unknown as { id: number; kind: string; payload_json: string; attempts: number }[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      payload: JSON.parse(r.payload_json),
      attempts: r.attempts
    }))
  }

  /** Kedy najskôr bude pripravená ďalšia odložená operácia (ms od teraz), alebo null. */
  nextDelayedOperation(accountId: number): number | null {
    const r = this.db
      .prepare(`SELECT MIN(not_before) AS t FROM operations WHERE account_id = ? AND state IN ('pending','failed') AND attempts < 3 AND not_before IS NOT NULL`)
      .get(accountId) as { t: string | null }
    return r.t ? Math.max(0, new Date(r.t).getTime() - Date.now()) : null
  }

  /** Označí operáciu ako práve vykonávanú. Vráti false, ak ju medzitým zrušil „Vrátiť späť“. */
  claimOperation(id: number): boolean {
    return Number(this.db.prepare(`UPDATE operations SET state = 'running' WHERE id = ? AND state IN ('pending','failed')`).run(id).changes) === 1
  }

  /** Spojenie sa prerušilo počas vykonávania – operácia sa zopakuje (všetky sú bezpečné na zopakovanie). */
  releaseOperation(id: number): void {
    this.db.prepare(`UPDATE operations SET state = 'pending' WHERE id = ? AND state = 'running'`).run(id)
  }

  /** Po páde aplikácie: rozpracované operácie znova do fronty. */
  resetRunningOperations(): void {
    this.db.prepare(`UPDATE operations SET state = 'pending' WHERE state = 'running'`).run()
  }

  /** „Vrátiť späť“: zruší operáciu, ak ešte nezačala. Vráti jej údaje, alebo null. */
  cancelOperation(id: number): { kind: string; payload: unknown } | null {
    const r = this.db.prepare(`DELETE FROM operations WHERE id = ? AND state = 'pending' AND attempts = 0 RETURNING kind, payload_json`).get(id) as
      | { kind: string; payload_json: string }
      | undefined
    return r ? { kind: r.kind, payload: JSON.parse(r.payload_json) } : null
  }

  finishOperation(id: number, ok: boolean, error?: string): void {
    this.db
      .prepare(`UPDATE operations SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(ok ? 'done' : 'failed', error ?? null, id)
  }

  /** Čaká operácia daného druhu s presne týmto obsahom (napr. nahratie konceptu)? */
  hasPendingOperation(accountId: number, kind: string, payload: unknown): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM operations WHERE account_id = ? AND kind = ? AND payload_json = ? AND state IN ('pending','failed') AND attempts < 3`)
      .get(accountId, kind, JSON.stringify(payload))
  }

  /** Čakajúcu operáciu vykonať hneď (zrušiť odklad). */
  expediteOperation(accountId: number, kind: string, payload: unknown): void {
    this.db
      .prepare(`UPDATE operations SET not_before = NULL WHERE account_id = ? AND kind = ? AND payload_json = ? AND state IN ('pending','failed')`)
      .run(accountId, kind, JSON.stringify(payload))
  }

  /** Všetky originály a prílohy, na ktoré niečo odkazuje (na upratanie úložiska). */
  referencedBlobs(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT blob_sha256 AS s FROM messages WHERE blob_sha256 IS NOT NULL
         UNION SELECT blob_sha256 FROM outbox
         UNION SELECT json_extract(j.value, '$.sha') FROM drafts, json_each(drafts.attachments_json) j`
      )
      .all() as { s: string | null }[]
    return new Set(rows.map((r) => r.s).filter((x): x is string => !!x))
  }

  // ---------- koncepty ----------

  messageByUid(folderId: number, uid: number): number | null {
    return (this.db.prepare('SELECT id FROM messages WHERE folder_id = ? AND uid = ?').get(folderId, uid) as { id: number } | undefined)?.id ?? null
  }

  /** Lokálna správa konta s daným Message-ID (napr. pôvodná správa, na ktorú koncept odpovedá). */
  messageByMessageId(accountId: number, messageId: string): number | null {
    const key = normalizeMessageId(messageId)
    if (!key) return null
    const rows = this.db.prepare(`SELECT id, message_id FROM messages WHERE account_id = ? AND message_id LIKE ? ORDER BY id`).all(accountId, `%${key.replace(/[%_]/g, '')}%`) as {
      id: number
      message_id: string
    }[]
    return rows.find((r) => normalizeMessageId(r.message_id) === key)?.id ?? null
  }

  draft(id: number): DraftRow | null {
    return (this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as unknown as DraftRow | undefined) ?? null
  }

  /** Lokálny koncept podľa Message-ID (koncept otvorený zo servera). */
  draftByMessageId(messageId: string): DraftRow | null {
    const key = normalizeMessageId(messageId)
    if (!key) return null
    const rows = this.db.prepare('SELECT * FROM drafts WHERE deleted = 0 ORDER BY id DESC').all() as unknown as DraftRow[]
    return rows.find((r) => normalizeMessageId(r.message_id) === key) ?? null
  }

  insertDraft(d: { accountId: number; messageId: string; data: unknown; attachments: unknown; serverFolderId?: number | null; serverUid?: number | null; synced?: boolean }): number {
    return (this.db
      .prepare(
        `INSERT INTO drafts (account_id, message_id, data_json, attachments_json, server_folder_id, server_uid, rev, server_rev)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?) RETURNING id`
      )
      .get(d.accountId, d.messageId, JSON.stringify(d.data), JSON.stringify(d.attachments), d.serverFolderId ?? null, d.serverUid ?? null, d.synced ? 1 : 0) as { id: number }).id
  }

  /** Nový obsah konceptu (zvýši revíziu – na server sa nahrá pri najbližšej príležitosti). */
  updateDraft(id: number, d: { accountId: number; data: unknown; attachments: unknown }): void {
    this.db
      .prepare(
        `UPDATE drafts SET account_id = ?, data_json = ?, attachments_json = ?, rev = rev + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      )
      .run(d.accountId, JSON.stringify(d.data), JSON.stringify(d.attachments), id)
  }

  setDraftServer(id: number, folderId: number | null, uid: number | null, rev?: number): void {
    if (rev === undefined) this.db.prepare('UPDATE drafts SET server_folder_id = ?, server_uid = ? WHERE id = ?').run(folderId, uid, id)
    else this.db.prepare('UPDATE drafts SET server_folder_id = ?, server_uid = ?, server_rev = ? WHERE id = ?').run(folderId, uid, rev, id)
  }

  markDraftDeleted(id: number): void {
    this.db.prepare('UPDATE drafts SET deleted = 1 WHERE id = ?').run(id)
  }

  deleteDraft(id: number): void {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
  }

  /** Smie sa obsah s týmto SHA použiť ako príloha? Len prílohy uložené v niektorom koncepte. */
  isDraftBlob(sha: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(sha)) return false
    return !!this.db.prepare(`SELECT 1 FROM drafts, json_each(drafts.attachments_json) j WHERE json_extract(j.value, '$.sha') = ? LIMIT 1`).get(sha)
  }

  setHidden(ids: number[], hidden: boolean): void {
    const st = this.db.prepare('UPDATE messages SET hidden = ? WHERE id = ?')
    for (const id of ids) st.run(hidden ? 1 : 0, id)
  }

  deleteMessages(ids: number[]): void {
    const st = this.db.prepare('DELETE FROM messages WHERE id = ?')
    this.db.exec('BEGIN')
    try {
      for (const id of ids) st.run(id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * Presun potvrdený serverom: ak server oznámil nové UID (UIDPLUS), záznam sa presunie aj lokálne
   * (originál sa netreba sťahovať znova); inak sa lokálny záznam zmaže a cieľový priečinok ho načíta pri synchronizácii.
   */
  completeMove(messageIds: number[], oldUids: number[], targetFolderId: number, uidMap: Map<number, number> | undefined): void {
    const move = this.db.prepare(`UPDATE messages SET folder_id = ?, uid = ?, hidden = 0, local_state = 'synced' WHERE id = ?`)
    const del = this.db.prepare('DELETE FROM messages WHERE id = ?')
    for (const [i, id] of messageIds.entries()) {
      const newUid = uidMap?.get(oldUids[i]!)
      if (newUid === undefined) {
        del.run(id)
        continue
      }
      try {
        move.run(targetFolderId, newUid, id)
      } catch {
        // Synchronizácia cieľového priečinka ju už medzitým načítala.
        del.run(id)
      }
    }
  }

  /** Viditeľné ID správ v priečinku (alebo spoločnej doručenej pošte) – pre „Vybrať všetko“. */
  listIds(folderId: number | null): number[] {
    const where = `${folderId === null ? `f.special_use = 'inbox'` : 'm.folder_id = ?'} AND m.hidden = 0`
    return (this.db
      .prepare(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE ${where} ORDER BY COALESCE(m.internal_date, m.date_header) DESC, m.id DESC`)
      .all(...(folderId === null ? [] : [folderId])) as { id: number }[]).map((r) => r.id)
  }

  specialFolder(accountId: number, use: SpecialUse): FolderRow | null {
    return this.folderRows(accountId).find((f) => f.special_use === use) ?? null
  }
}

export interface DraftRow {
  id: number
  account_id: number
  message_id: string
  data_json: string
  attachments_json: string
  server_folder_id: number | null
  server_uid: number | null
  rev: number
  server_rev: number
  deleted: number
}

/** Message-ID bez zátvoriek a medzier, malými písmenami (na porovnanie). */
export function normalizeMessageId(v: string | null | undefined): string {
  return (v ?? '').trim().replace(/^<|>$/g, '').toLowerCase()
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
