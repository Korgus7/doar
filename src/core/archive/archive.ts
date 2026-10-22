import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Db } from '../store/db'
import type { FileGrants } from '../files'
import type { ArchiveState, ArchiveSummary, CoreEvents, EventChannel, FolderItem, MessageListItem, MessageView, SpecialUse } from '../../shared/ipc'
import { encodeFolderPath, decodeFolderPath } from '../export/mboxrd'
import { parseEntry, readEntryAt, readMbox, NotMboxError } from '../import/mbox-reader'
import { archiveInfo } from '../mail/parse'
import { buildView } from '../view'
import { logger } from '../log'

const log = logger('archive')

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const BATCH = 200
const ARCHIVE_COLOR = '#868e96'

const SPECIAL: Record<string, SpecialUse> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all'
}
const ORDER: Record<string, number> = { inbox: 0, drafts: 1, sent: 2, archive: 3, all: 4, junk: 5, trash: 6 }

interface ArchiveRow {
  id: number
  path: string
  name: string
  size: number
  mtime_ms: number
  state: ArchiveState
  message_count: number
  doar: number
  source: string | null
  error: string | null
}

interface MessageRow {
  id: number
  archive_id: number
  folder_id: number
  mbox_offset: number
  mbox_length: number
  fingerprint: string
  subject: string
  from_addr: string
  date: string | null
  path: string
}

export interface ArchiveDeps {
  db: Db
  files: FileGrants
  emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
  fetchRemote?: (urls: string[]) => Promise<Map<string, string>>
}

/**
 * Lokálny archív: súbor mbox otvorený len na čítanie. Súbor sa nikdy nemení – Doar si v databáze drží
 * len zoznam správ (pozícia a dĺžka v súbore), údaje pre zoznam a fulltext. Obsah správy sa pri otvorení
 * prečíta zo súboru a overí odtlačkom (ak sa súbor medzitým zmenil, archív sa načíta znova).
 * Pre rozhranie majú priečinky a správy archívu záporné ID.
 */
export class ArchiveManager {
  private indexing = new Map<number, { controller: AbortController; progress: ArchiveSummary['progress']; promise: Promise<void> }>()

  constructor(private readonly deps: ArchiveDeps) {}

  /** Po štarte: rozpracované načítanie zopakovať, chýbajúci alebo zmenený súbor zistiť. */
  async init(): Promise<void> {
    for (const a of this.rows()) await this.check(a)
  }

  private rows(): ArchiveRow[] {
    return this.deps.db.prepare(`SELECT * FROM archives ORDER BY id`).all() as unknown as ArchiveRow[]
  }

  private row(id: number): ArchiveRow | null {
    return (this.deps.db.prepare(`SELECT * FROM archives WHERE id = ?`).get(id) as unknown as ArchiveRow | undefined) ?? null
  }

  private setState(id: number, state: ArchiveState, error: string | null = null): void {
    this.deps.db.prepare(`UPDATE archives SET state = ?, error = ? WHERE id = ?`).run(state, error, id)
    this.deps.emit('archives.changed', null)
  }

  /** Súbor archívu: chýba → „missing“; zmenený alebo nedokončené načítanie → načítať znova. */
  private async check(a: ArchiveRow): Promise<void> {
    if (this.indexing.has(a.id)) return
    const st = await stat(a.path).catch(() => null)
    if (!st?.isFile()) {
      if (a.state !== 'missing') this.setState(a.id, 'missing')
      return
    }
    const changed = st.size !== a.size || Math.round(st.mtimeMs) !== Math.round(a.mtime_ms)
    if (a.state === 'indexing' || changed || (a.state === 'missing' && changed)) this.startIndex(a.id)
    else if (a.state === 'missing') this.setState(a.id, 'ready')
  }

  async open(path: string): Promise<{ archiveId: number }> {
    const p = await this.deps.files.require(typeof path === 'string' ? path : '', 'read')
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) throw err('FILE_MISSING', 'Súbor sa nenašiel')
    const existing = this.deps.db.prepare(`SELECT * FROM archives WHERE path = ?`).get(p) as unknown as ArchiveRow | undefined
    if (existing) {
      await this.check(existing)
      return { archiveId: existing.id }
    }
    const id = (this.deps.db.prepare(`INSERT INTO archives (path, name, state) VALUES (?, ?, 'indexing') RETURNING id`).get(p, basename(p)) as { id: number }).id
    this.startIndex(id)
    this.deps.emit('archives.changed', null)
    return { archiveId: id }
  }

  /** Zatvorí archív: zmaže zoznam a fulltext v Doare. Súbor na disku zostane nezmenený. */
  async close(id: number): Promise<void> {
    const run = this.indexing.get(id)
    if (run) {
      run.controller.abort()
      await run.promise.catch(() => {})
    }
    this.clearIndex(id)
    this.deps.db.prepare(`DELETE FROM archives WHERE id = ?`).run(id)
    this.deps.emit('archives.changed', null)
  }

  /** Pre testy: počká na dokončenie načítania. */
  async wait(id: number): Promise<void> {
    await this.indexing.get(id)?.promise
  }

  async cancelAll(): Promise<void> {
    const list = [...this.indexing.values()]
    for (const r of list) r.controller.abort()
    await Promise.allSettled(list.map((r) => r.promise))
  }

  private clearIndex(id: number): void {
    const db = this.deps.db
    db.exec('BEGIN')
    try {
      db.prepare(`DELETE FROM archive_fts WHERE rowid IN (SELECT id FROM archive_messages WHERE archive_id = ?)`).run(id)
      db.prepare(`DELETE FROM archive_messages WHERE archive_id = ?`).run(id)
      db.prepare(`DELETE FROM archive_folders WHERE archive_id = ?`).run(id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  private startIndex(id: number): void {
    if (this.indexing.has(id)) return
    const controller = new AbortController()
    const entry = { controller, progress: null as ArchiveSummary['progress'], promise: Promise.resolve() }
    this.indexing.set(id, entry)
    this.deps.db.prepare(`UPDATE archives SET state = 'indexing', error = NULL WHERE id = ?`).run(id)
    this.deps.emit('archives.changed', null)
    entry.promise = this.index(id, controller.signal, (p) => {
      entry.progress = p
      this.deps.emit('archives.progress', { archiveId: id, ...p })
    })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        const code = e instanceof NotMboxError ? 'NOT_MBOX' : ((e as { code?: string }).code ?? 'UNKNOWN')
        log.warn('archív sa nepodarilo načítať', { archive: id, code })
        if (this.row(id)) this.setState(id, code === 'ENOENT' ? 'missing' : 'failed', code)
      })
      .finally(() => {
        this.indexing.delete(id)
        this.deps.emit('archives.changed', null)
      })
  }

  /** Prejde súbor prúdom a zapíše zoznam správ, priečinky a fulltext. */
  private async index(id: number, signal: AbortSignal, onProgress: (p: NonNullable<ArchiveSummary['progress']>) => void): Promise<void> {
    const db = this.deps.db
    const a = this.row(id)
    if (!a) return
    const st = await stat(a.path)
    this.clearIndex(id)
    const folderIds = new Map<string, number>()
    const insFolder = db.prepare(`INSERT INTO archive_folders (archive_id, key, name, special_use) VALUES (?, ?, ?, ?) RETURNING id`)
    const insMsg = db.prepare(
      `INSERT INTO archive_messages (archive_id, folder_id, seq, mbox_offset, mbox_length, fingerprint, subject, from_name, from_addr, to_json, date, seen, flagged, answered, has_attachments, snippet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    const insFts = db.prepare(`INSERT INTO archive_fts (rowid, subject, from_text, to_text, body_text) VALUES (?, ?, ?, ?, ?)`)
    type Pending = { folder: number; seq: number; offset: number; length: number; fp: string; info: Awaited<ReturnType<typeof archiveInfo>>; flags: Set<string>; date: string | null }
    let batch: Pending[] = []
    let count = 0
    let doar = false
    let source: string | null = null
    let bytesRead = 0
    let lastEmit = 0
    const flush = (): void => {
      if (!batch.length) return
      db.exec('BEGIN')
      try {
        for (const m of batch) {
          const from = m.info.from[0]
          const to = [...m.info.to, ...m.info.cc]
          const row = insMsg.get(
            id, m.folder, m.seq, m.offset, m.length, m.fp, m.info.subject, from?.name ?? '', from?.address ?? '', JSON.stringify(to), m.date,
            m.flags.has('\\Seen') ? 1 : 0, m.flags.has('\\Flagged') ? 1 : 0, m.flags.has('\\Answered') ? 1 : 0, m.info.hasAttachments ? 1 : 0, m.info.snippet
          ) as { id: number }
          insFts.run(row.id, m.info.subject, `${from?.name ?? ''} ${from?.address ?? ''}`, to.map((x) => `${x.name} ${x.address}`).join(' '), m.info.bodyText.slice(0, 200_000))
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      batch = []
    }
    const folderOf = (segments: string[] | null, specialUse: string | null): number => {
      const key = segments ? encodeFolderPath(segments) : ''
      let fid = folderIds.get(key)
      if (fid === undefined) {
        fid = (insFolder.get(id, key, segments ? segments.join(' / ') : '', specialUse ? (SPECIAL[specialUse] ?? null) : null) as { id: number }).id
        folderIds.set(key, fid)
      }
      return fid
    }
    let seq = 0
    for await (const e of readMbox(a.path, { signal, onBytes: (n) => (bytesRead = n) })) {
      seq++
      const p = parseEntry(e.raw)
      if (!p) continue
      if (p.doar) {
        doar = true
        source ??= p.source
      }
      let info: Awaited<ReturnType<typeof archiveInfo>>
      try {
        info = await archiveInfo(p.original)
      } catch {
        info = { subject: '', from: [], to: [], cc: [], date: null, snippet: '', hasAttachments: false, bodyText: '' }
      }
      batch.push({
        folder: folderOf(p.doar ? p.folderSegments : null, p.doar ? p.specialUse : null),
        seq,
        offset: e.offset,
        length: e.length,
        fp: p.fingerprint,
        info,
        flags: p.flags,
        date: p.internalDate?.toISOString() ?? info.date
      })
      count++
      if (batch.length >= BATCH) flush()
      const now = Date.now()
      if (now - lastEmit > 250) {
        lastEmit = now
        onProgress({ bytesRead, fileSize: st.size, messages: count })
      }
    }
    if (signal.aborted) return
    flush()
    db.prepare(
      `UPDATE archive_folders SET total = (SELECT COUNT(*) FROM archive_messages m WHERE m.folder_id = archive_folders.id),
         unread = (SELECT COUNT(*) FROM archive_messages m WHERE m.folder_id = archive_folders.id AND m.seen = 0)
       WHERE archive_id = ?`
    ).run(id)
    db.prepare(`UPDATE archives SET size = ?, mtime_ms = ?, state = 'ready', message_count = ?, doar = ?, source = ?, error = NULL WHERE id = ?`).run(
      st.size,
      Math.round(st.mtimeMs),
      count,
      doar ? 1 : 0,
      source,
      id
    )
    onProgress({ bytesRead: st.size, fileSize: st.size, messages: count })
    log.info('archív načítaný', { archive: id, messages: count })
  }

  // ---------- pre rozhranie ----------

  list(): { archives: ArchiveSummary[]; folders: FolderItem[] } {
    const archives = this.rows().map((a) => ({
      id: a.id,
      name: a.name,
      path: a.path,
      state: a.state,
      messageCount: a.message_count,
      sizeBytes: a.size,
      doar: !!a.doar,
      source: a.source,
      error: a.error,
      progress: this.indexing.get(a.id)?.progress ?? null
    }))
    const rows = this.deps.db
      .prepare(`SELECT f.* FROM archive_folders f JOIN archives a ON a.id = f.archive_id WHERE a.state <> 'indexing' ORDER BY f.archive_id`)
      .all() as { id: number; archive_id: number; key: string; name: string; special_use: SpecialUse | null; total: number; unread: number }[]
    rows.sort((x, y) => x.archive_id - y.archive_id || (ORDER[x.special_use ?? ''] ?? 9) - (ORDER[y.special_use ?? ''] ?? 9) || x.name.localeCompare(y.name, 'sk'))
    const folders: FolderItem[] = rows.map((f) => ({
      id: -f.id,
      accountId: -f.archive_id,
      path: f.key ? decodeFolderPath(f.key).join('/') : '',
      name: f.name,
      parentPath: null,
      specialUse: f.special_use,
      selectable: true,
      unread: f.unread,
      total: f.total,
      localCount: f.total,
      depth: 0
    }))
    return { archives, folders }
  }

  private scope(s: { folderId?: number | null; archiveId?: number | null }): { where: string; args: number[] } {
    if (s.folderId != null && s.folderId < 0) return { where: 'm.folder_id = ?', args: [-s.folderId] }
    if (s.archiveId != null) return { where: 'm.archive_id = ?', args: [s.archiveId] }
    return { where: '0', args: [] }
  }

  private query(where: string, args: (string | number)[], offset: number, limit: number): { total: number; items: MessageListItem[] } {
    const db = this.deps.db
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM archive_messages m WHERE ${where}`).get(...args) as { c: number }).c
    const rows = db
      .prepare(
        `SELECT m.id, m.archive_id, m.folder_id, m.subject, m.from_name, m.from_addr, m.to_json, m.date, m.seen, m.flagged, m.answered, m.has_attachments, m.snippet, a.name AS archive_name
         FROM archive_messages m JOIN archives a ON a.id = m.archive_id WHERE ${where} ORDER BY m.date DESC, m.id DESC LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset) as {
      id: number
      archive_id: number
      folder_id: number
      subject: string
      from_name: string
      from_addr: string
      to_json: string
      date: string | null
      seen: number
      flagged: number
      answered: number
      has_attachments: number
      snippet: string
      archive_name: string
    }[]
    return {
      total,
      items: rows.map((r) => ({
        id: -r.id,
        accountId: -r.archive_id,
        folderId: -r.folder_id,
        subject: r.subject,
        fromName: r.from_name,
        fromAddr: r.from_addr,
        to: (JSON.parse(r.to_json) as { name: string; address: string }[]).map((x) => x.name || x.address),
        date: r.date,
        seen: !!r.seen,
        flagged: !!r.flagged,
        answered: !!r.answered,
        hasAttachments: !!r.has_attachments,
        snippet: r.snippet,
        localState: 'synced',
        downloaded: true,
        accountColor: ARCHIVE_COLOR,
        accountName: r.archive_name
      }))
    }
  }

  listMessages(folderId: number, offset: number, limit: number): { total: number; items: MessageListItem[] } {
    const s = this.scope({ folderId })
    return this.query(s.where, s.args, offset, limit)
  }

  listIds(folderId: number): number[] {
    const s = this.scope({ folderId })
    return (this.deps.db.prepare(`SELECT m.id FROM archive_messages m WHERE ${s.where} ORDER BY m.date DESC, m.id DESC`).all(...s.args) as { id: number }[]).map((r) => -r.id)
  }

  search(fts: string, scope: { folderId?: number | null; archiveId?: number | null }, offset: number, limit: number): { total: number; items: MessageListItem[]; notDownloaded: number } {
    const s = this.scope(scope)
    return { ...this.query(`${s.where} AND m.id IN (SELECT rowid FROM archive_fts WHERE archive_fts MATCH ?)`, [...s.args, fts], offset, limit), notDownloaded: 0 }
  }

  searchIds(fts: string, scope: { folderId?: number | null; archiveId?: number | null }): number[] {
    const s = this.scope(scope)
    return (this.deps.db
      .prepare(`SELECT m.id FROM archive_messages m WHERE ${s.where} AND m.id IN (SELECT rowid FROM archive_fts WHERE archive_fts MATCH ?) ORDER BY m.date DESC, m.id DESC`)
      .all(...s.args, fts) as { id: number }[]).map((r) => -r.id)
  }

  private message(uiId: number): MessageRow {
    const r = this.deps.db
      .prepare(
        `SELECT m.id, m.archive_id, m.folder_id, m.mbox_offset, m.mbox_length, m.fingerprint, m.subject, m.from_addr, m.date, a.path
         FROM archive_messages m JOIN archives a ON a.id = m.archive_id WHERE m.id = ?`
      )
      .get(-uiId) as unknown as MessageRow | undefined
    if (!r) throw err('NOT_FOUND', 'Správa neexistuje')
    return r
  }

  /** Zdroj zálohy (konto) a dátum správy – pre odpoveď z archívu. */
  meta(uiId: number): { source: string | null; date: string | null } {
    const m = this.message(uiId)
    return { source: this.row(m.archive_id)?.source ?? null, date: m.date }
  }

  /** Pôvodná správa zo súboru archívu (overená odtlačkom). */
  async raw(uiId: number): Promise<Buffer> {
    const m = this.message(uiId)
    const buf = await readEntryAt(m.path, m.mbox_offset, m.mbox_length).catch(() => null)
    if (!buf) {
      this.setState(m.archive_id, 'missing')
      throw err('ARCHIVE_FILE_MISSING', 'Súbor archívu sa nenašiel')
    }
    const p = parseEntry(buf)
    if (!p || p.fingerprint !== m.fingerprint) {
      // Súbor sa zmenil – zoznam treba načítať znova.
      const a = this.row(m.archive_id)
      if (a) void this.check({ ...a, size: -1 })
      throw err('ARCHIVE_CHANGED', 'Súbor archívu sa zmenil')
    }
    return p.original
  }

  async view(uiId: number, opts: { showRemote?: boolean; alwaysForSender?: boolean }): Promise<MessageView> {
    const m = this.message(uiId)
    const raw = await this.raw(uiId)
    return buildView(this.deps, raw, { id: uiId, accountId: -m.archive_id, subject: m.subject, date: m.date, sender: m.from_addr }, opts)
  }
}
