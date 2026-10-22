import type { ImapFlow, ListResponse } from 'imapflow'
import { stat } from 'node:fs/promises'
import type { Db } from '../store/db'
import type { BlobStore } from '../store/blobs'
import type { MailStore } from '../store/mailstore'
import type { CoreEvents, EventChannel, ImportFolderSummary, ImportMode, ImportPhase, ImportProgress, ImportSummary, SpecialUse } from '../../shared/ipc'
import { canonicalize, decodeFolderPath, encodeFolderPath, sha256 } from '../export/mboxrd'
import { DEFAULT_NAMES, toFolderInfo } from '../sync/account-sync'
import { classifyError } from '../mail/connection-test'
import { fromAddress, normMessageId, parseEntry, readEntryAt, readMbox, weakKey, NotMboxError } from './mbox-reader'
import { logger } from '../log'

const log = logger('import')

const RECONNECT_DELAYS = [2000, 5000, 10000]
const INSERT_BATCH = 500
const FETCH_CHUNK = 25
const SYSTEM_FLAGS = ['\\Seen', '\\Flagged', '\\Answered', '\\Draft']

export interface ImportDeps {
  db: Db
  store: MailStore
  blobs: BlobStore
  /** Nové nepripojené IMAP spojenie pre konto. */
  newClient(accountId: number): Promise<ImapFlow>
  emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
  /** Po obnove: synchronizovať konto, aby sa nové správy ukázali v zozname. */
  afterImport?(accountId: number): void
}

/** Nastavenie úlohy – uložené v jobs.progress_json, aby sa dalo pokračovať aj po reštarte. */
export interface ImportConfig {
  path: string
  fileName: string
  fileSize: number
  fileMtimeMs: number
  mode: ImportMode
  target: { folderPath: string } | { newName: string }
  /** Súbor už bol celý prejdený a správy zapísané do import_items. */
  scanned: boolean
  startedAt: string
  /** Oddeľovač priečinkov cieľového servera (pre súhrn). */
  delimiter?: string
}

export interface ImportRun {
  jobId: number
  accountId: number
  signal: AbortSignal
  onProgress(p: ImportProgress): void
  /** Len pre testy: zavolá sa pred nahratím každej správy. */
  beforeAppend?: (seq: number) => Promise<void>
}

type ItemState = 'pending' | 'appending' | 'appended' | 'duplicate' | 'failed' | 'skipped'

interface ItemRow {
  seq: number
  mbox_offset: number
  mbox_length: number
  fingerprint: string
  weak_key: string
  size: number
  target_desc: string
  target_folder: string | null
  target_uidvalidity: number | null
  state: ItemState
  appended_uid: number | null
  error: string | null
}

class Cancelled extends Error {
  constructor() {
    super('Obnova bola zrušená')
  }
}

class ImportFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Dá sa neskôr pokračovať. */
    readonly resumable = true
  ) {
    super(message)
  }
}

const SPECIAL_FROM_FLAG: Record<string, SpecialUse> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive'
}
const FLAG_FROM_SPECIAL: Record<string, string> = { sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', junk: '\\Junk', archive: '\\Archive' }

/**
 * Kam správa patrí (nezávisle od servera): „special:sent“, „path:Fakt%C3%BAry/2026“, alebo „fallback“
 * (zvolený priečinok). Gmail (Všetka pošta): Doručená → Odoslané → prvý vlastný štítok → Archív.
 */
export function targetDesc(mode: ImportMode, p: { doar: boolean; folderSegments: string[] | null; specialUse: string | null; gmailLabels: string[] }): string {
  if (mode === 'single' || !p.doar || !p.folderSegments) return 'fallback'
  const su = p.specialUse ? SPECIAL_FROM_FLAG[p.specialUse] : undefined
  if (su) return `special:${su}`
  if (p.specialUse === '\\All') {
    if (p.gmailLabels.includes('\\Inbox')) return 'special:inbox'
    if (p.gmailLabels.includes('\\Sent')) return 'special:sent'
    const label = p.gmailLabels.find((l) => !l.startsWith('\\'))
    if (label) return `path:${encodeFolderPath(label.split('/').filter(Boolean))}`
    return 'special:archive'
  }
  if (!p.folderSegments.length) return 'fallback'
  return `path:${encodeFolderPath(p.folderSegments)}`
}

function isAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Cancelled()
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled())
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Cancelled())), { once: true })
  })

function isQuota(e: unknown): boolean {
  const x = e as { serverResponseCode?: string; response?: unknown; responseText?: string }
  if (x?.serverResponseCode === 'OVERQUOTA') return true
  const text = `${typeof x?.response === 'string' ? x.response : ''} ${x?.responseText ?? ''}`
  return /quota|mailbox (is )?full/i.test(text)
}

/** Jedna obnova (nová alebo pokračovanie). Postup: 1. prečítanie súboru, 2. priečinky, 3. kontrola duplicít, 4. nahrávanie. */
export async function importToAccount(deps: ImportDeps, run: ImportRun): Promise<ImportSummary> {
  const db = deps.db
  const job = db.prepare(`SELECT progress_json FROM jobs WHERE id = ?`).get(run.jobId) as { progress_json: string } | undefined
  const acc = db.prepare('SELECT email, provider_key FROM accounts WHERE id = ?').get(run.accountId) as { email: string; provider_key: string | null } | undefined
  if (!job || !acc) throw new ImportFailure('NO_ACCOUNT', 'Konto neexistuje', false)
  const cfg = JSON.parse(job.progress_json) as ImportConfig
  const saveCfg = (): void => void db.prepare(`UPDATE jobs SET progress_json = ? WHERE id = ?`).run(JSON.stringify(cfg), run.jobId)

  const progress: ImportProgress = {
    jobId: run.jobId,
    accountId: run.accountId,
    phase: 'scan',
    fileName: cfg.fileName,
    bytesRead: 0,
    fileSize: cfg.fileSize,
    messagesTotal: 0,
    foldersDone: 0,
    foldersTotal: 0,
    toUpload: 0,
    uploaded: 0,
    duplicates: 0,
    failed: 0
  }
  let lastEmit = 0
  const emit = (phase?: ImportPhase, force = false): void => {
    if (phase) progress.phase = phase
    const now = Date.now()
    if (!force && !phase && now - lastEmit < 200) return
    lastEmit = now
    run.onProgress({ ...progress })
  }

  const items = (where = ''): ItemRow[] => db.prepare(`SELECT * FROM import_items WHERE job_id = ? ${where} ORDER BY seq`).all(run.jobId) as unknown as ItemRow[]
  const itemsIn = (path: string): ItemRow[] =>
    db.prepare(`SELECT * FROM import_items WHERE job_id = ? AND target_folder = ? AND state <> 'skipped' ORDER BY seq`).all(run.jobId, path) as unknown as ItemRow[]
  const setItem = db.prepare(`UPDATE import_items SET state = ?, appended_uid = ?, target_uidvalidity = COALESCE(?, target_uidvalidity), error = ? WHERE job_id = ? AND seq = ?`)
  const update = (it: ItemRow, state: ItemState, extra: { uid?: number | null; uidvalidity?: number | null; error?: string | null } = {}): void => {
    it.state = state
    if (extra.uid !== undefined) it.appended_uid = extra.uid
    it.error = extra.error ?? null
    setItem.run(state, it.appended_uid, extra.uidvalidity ?? null, it.error, run.jobId, it.seq)
  }

  let client: ImapFlow | null = null
  let gmailTarget = acc.provider_key === 'gmail'
  const connect = async (): Promise<ImapFlow> => {
    if (client?.usable) return client
    client?.close()
    let lastErr: unknown
    for (let attempt = 0; attempt <= RECONNECT_DELAYS.length; attempt++) {
      isAbort(run.signal)
      try {
        const c = await deps.newClient(run.accountId)
        await c.connect()
        client = c
        if (c.capabilities.has('X-GM-EXT-1')) gmailTarget = true
        return c
      } catch (e) {
        lastErr = e
        const code = classifyError(e).code
        if (code === 'AUTH_FAILED' || code?.startsWith('CERT_') || (e as { code?: string }).code === 'PASSWORD_REQUIRED') break
        if (attempt < RECONNECT_DELAYS.length) await sleep(RECONNECT_DELAYS[attempt]!, run.signal)
      }
    }
    const code = (lastErr as { code?: string })?.code === 'PASSWORD_REQUIRED' ? 'PASSWORD_REQUIRED' : (classifyError(lastErr).code ?? 'UNKNOWN')
    throw new ImportFailure(code, 'Nepodarilo sa pripojiť k serveru')
  }

  const folderMeta = new Map<string, { uidvalidity: number; keywordsOk: boolean }>()
  let keywordsDropped = 0

  try {
    // ---------- 1. prečítanie súboru ----------
    emit('scan', true)
    const st = await stat(cfg.path).catch(() => null)
    if (!st) throw new ImportFailure('FILE_MISSING', 'Súbor zálohy sa nenašiel')
    if (cfg.scanned && (st.size !== cfg.fileSize || Math.round(st.mtimeMs) !== Math.round(cfg.fileMtimeMs))) {
      throw new ImportFailure('FILE_CHANGED', 'Súbor zálohy sa medzitým zmenil', false)
    }
    if (!cfg.scanned) {
      cfg.fileSize = st.size
      cfg.fileMtimeMs = st.mtimeMs
      progress.fileSize = st.size
      db.prepare(`DELETE FROM import_items WHERE job_id = ?`).run(run.jobId)
      const ins = db.prepare(
        `INSERT INTO import_items (job_id, seq, mbox_offset, mbox_length, fingerprint, weak_key, size, target_desc, state, changed_outside, foreign_format)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      let seq = 0
      let batch: unknown[][] = []
      const flush = (): void => {
        if (!batch.length) return
        db.exec('BEGIN')
        try {
          for (const b of batch) ins.run(...(b as (string | number)[]))
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
        batch = []
      }
      try {
        for await (const e of readMbox(cfg.path, { signal: run.signal, onBytes: (n) => ((progress.bytesRead = n), emit()) })) {
          const p = parseEntry(e.raw)
          seq++
          if (!p) batch.push([run.jobId, seq, e.offset, e.length, '', '', 0, '', 'skipped', 0, 0])
          else
            batch.push([run.jobId, seq, e.offset, e.length, p.fingerprint, p.weakKey, p.size, targetDesc(cfg.mode, p), 'pending', p.hashOk === false ? 1 : 0, p.doar ? 0 : 1])
          progress.messagesTotal = seq
          if (batch.length >= INSERT_BATCH) flush()
        }
      } catch (e) {
        if (e instanceof NotMboxError) throw new ImportFailure('NOT_MBOX', 'Súbor nie je vo formáte mbox', false)
        throw e
      }
      isAbort(run.signal)
      flush()
      if (!seq) throw new ImportFailure('NOT_MBOX', 'Súbor neobsahuje žiadne správy', false)
      cfg.scanned = true
      saveCfg()
    }
    progress.bytesRead = cfg.fileSize
    progress.messagesTotal = (db.prepare(`SELECT COUNT(*) AS n FROM import_items WHERE job_id = ?`).get(run.jobId) as { n: number }).n
    emit(undefined, true)

    // ---------- 2. cieľové priečinky ----------
    emit('folders', true)
    let c = await connect()
    const descs = (db.prepare(`SELECT DISTINCT target_desc AS d FROM import_items WHERE job_id = ? AND state <> 'skipped'`).all(run.jobId) as { d: string }[]).map((r) => r.d)
    const { map: resolved, delimiter } = await resolveTargets(deps, run.accountId, c, cfg, descs, gmailTarget)
    cfg.delimiter = delimiter
    saveCfg()
    const setTarget = db.prepare(`UPDATE import_items SET target_folder = ? WHERE job_id = ? AND target_desc = ?`)
    for (const [d, path] of resolved) setTarget.run(path, run.jobId, d)
    emit(undefined, true)

    // ---------- 3. kontrola duplicít ----------
    emit('check', true)
    // Pokračovanie: správy, ktoré predtým server odmietol, skúsime znova.
    db.prepare(`UPDATE import_items SET state = 'pending', error = NULL WHERE job_id = ? AND state = 'failed'`).run(run.jobId)
    const all = items(`AND state <> 'skipped'`)
    const byFolder = new Map<string, ItemRow[]>()
    for (const it of all) if (it.target_folder) byFolder.set(it.target_folder, [...(byFolder.get(it.target_folder) ?? []), it])
    const work = [...byFolder.entries()].filter(([, list]) => list.some((i) => i.state === 'pending' || i.state === 'appending'))
    progress.foldersTotal = work.length
    for (const [path, list] of work) {
      isAbort(run.signal)
      c = await connect()
      await planFolder(c, path, list)
      progress.foldersDone++
      emit()
    }
    const countState = (s: ItemState): number => (db.prepare(`SELECT COUNT(*) AS n FROM import_items WHERE job_id = ? AND state = ?`).get(run.jobId, s) as { n: number }).n
    progress.duplicates = countState('duplicate')
    progress.uploaded = countState('appended')
    progress.toUpload = countState('pending') + progress.uploaded
    emit(undefined, true)

    // ---------- 4. nahrávanie ----------
    emit('upload', true)
    const stateOf = db.prepare(`SELECT state FROM import_items WHERE job_id = ? AND seq = ?`)
    for (const it of items(`AND state = 'pending'`)) {
      isAbort(run.signal)
      // Nové porovnanie po výpadku spojenia mohlo správu medzitým nájsť na serveri.
      if (!it.target_folder || (stateOf.get(run.jobId, it.seq) as { state: string } | undefined)?.state !== 'pending') continue
      await run.beforeAppend?.(it.seq)
      isAbort(run.signal)
      const raw = await readEntryAt(cfg.path, it.mbox_offset, it.mbox_length).catch(() => null)
      const p = raw ? parseEntry(raw) : null
      if (!p || p.fingerprint !== it.fingerprint) throw new ImportFailure('FILE_CHANGED', 'Súbor zálohy sa medzitým zmenil', false)
      const meta = folderMeta.get(it.target_folder)
      const flags = SYSTEM_FLAGS.filter((f) => p.flags.has(f))
      const keywords = [...p.flags].filter((f) => !f.startsWith('\\'))
      if (keywords.length) {
        if (meta?.keywordsOk) flags.push(...keywords)
        else keywordsDropped++
      }

      update(it, 'appending')
      for (let attempt = 0; ; attempt++) {
        c = await connect()
        try {
          const res = await c.append(it.target_folder, p.original, flags, p.internalDate ?? undefined)
          if (!res) {
            // Spojenie nie je prihlásené – správa nebola odoslaná; nové spojenie a overenie ako pri výpadku.
            c.close()
            throw Object.assign(new Error('APPEND bez odpovede'), { code: 'NO_CONNECTION' })
          }
          update(it, 'appended', { uid: res.uid ?? null, uidvalidity: res.uidValidity ? Number(res.uidValidity) : (meta?.uidvalidity ?? null) })
          progress.uploaded++
          if (gmailTarget && res.uid) await addGmailLabels(c, it.target_folder, res.uid, p.gmailLabels)
          break
        } catch (e) {
          if (e instanceof Cancelled || e instanceof ImportFailure) throw e
          if (c.usable) {
            // Server správu jednoznačne odmietol (NO) – nebola uložená.
            if (isQuota(e)) {
              update(it, 'pending', { error: 'OVERQUOTA' })
              throw new ImportFailure('OVERQUOTA', 'Schránka je plná')
            }
            const code = (e as { serverResponseCode?: string }).serverResponseCode
            update(it, 'failed', { error: code === 'TOOBIG' || code === 'APPENDLIMIT' ? 'TOO_BIG' : code === 'LIMIT' ? 'LIMIT' : 'APPEND_REJECTED' })
            progress.failed++
            log.warn('server správu odmietol', { account: run.accountId, seq: it.seq, code })
            break
          }
          // Spojenie spadlo počas nahrávania: nevieme, či správa na serveri je. Po obnovení spojenia to overíme.
          if (attempt >= RECONNECT_DELAYS.length) throw new ImportFailure(classifyError(e).code ?? 'NO_NETWORK', 'Spojenie so serverom sa prerušilo')
          log.info('spojenie počas obnovy prerušené – overujem a pokračujem', { account: run.accountId })
          c = await connect()
          const folderItems = itemsIn(it.target_folder)
          await planFolder(c, it.target_folder, folderItems)
          const now = folderItems.find((x) => x.seq === it.seq)!
          if (now.state === 'appended') {
            it.state = 'appended'
            progress.uploaded++
            break
          }
          update(it, 'appending')
        }
      }
      emit()
    }
    emit(undefined, true)
    return finish(null)
  } catch (e) {
    const cancelled = e instanceof Cancelled
    const failure = e instanceof ImportFailure ? e : null
    const lost = (client as ImapFlow | null)?.usable === false
    const code = cancelled ? null : failure ? failure.code : (classifyError(e).code ?? (lost ? 'NO_NETWORK' : 'UNKNOWN'))
    if (!cancelled) log.warn('obnova sa zastavila', { account: run.accountId, code, error: e })
    return finish(cancelled ? 'cancelled' : code, failure ? failure.resumable : true)
  } finally {
    const c = client as ImapFlow | null
    if (c) {
      await c.logout().catch(() => {})
      c.close()
    }
    deps.afterImport?.(run.accountId)
  }

  // ---------- pomocné funkcie ----------

  /**
   * Porovná správy zo súboru so správami v priečinku na serveri. Každá správa na serveri „pokryje“ najviac
   * jednu správu zo súboru – tak sa správne obnoví aj viac rovnakých kópií a opakovaný import nič nezdvojí.
   * Správa s nejasným výsledkom nahrávania (appending) sa podľa toho označí ako nahraná alebo čakajúca.
   */
  async function planFolder(c: ImapFlow, path: string, list: ItemRow[]): Promise<void> {
    const lock = await c.getMailboxLock(path)
    try {
      const mb = c.mailbox
      if (!mb) return
      const uidvalidity = Number(mb.uidValidity)
      const perms = mb.permanentFlags ?? new Set<string>()
      folderMeta.set(path, { uidvalidity, keywordsOk: perms.has('\\*') })
      const onServer = new Set<number>()
      const byKey = new Map<string, number[]>()
      if (mb.exists > 0) {
        for await (const m of c.fetch('1:*', { uid: true, envelope: true })) {
          const env = m.envelope ?? {}
          const d = env.date ? new Date(env.date).getTime() : NaN
          const key = weakKey(normMessageId(env.messageId), Number.isNaN(d) ? null : d, fromAddress(env.from?.[0]?.address))
          onServer.add(m.uid)
          const l = byKey.get(key)
          if (l) l.push(m.uid)
          else byKey.set(key, [m.uid])
        }
      }
      const consumed = new Set<number>()
      const done = new Set<number>()
      // a) správy nahrané touto úlohou (UID poznáme)
      for (const it of list) {
        if (it.state === 'appended' && it.appended_uid && it.target_uidvalidity === uidvalidity && onServer.has(it.appended_uid) && !consumed.has(it.appended_uid)) {
          consumed.add(it.appended_uid)
          done.add(it.seq)
        }
      }
      // b) správy nahrané predošlými obnovami do tohto priečinka (aj keď ich server pri uložení upravil)
      const prev = new Map<string, number[]>()
      for (const r of db
        .prepare(
          `SELECT i.fingerprint AS fp, i.appended_uid AS uid FROM import_items i JOIN jobs j ON j.id = i.job_id
           WHERE j.kind = 'import' AND j.account_id = ? AND i.job_id <> ? AND i.target_folder = ? AND i.target_uidvalidity = ? AND i.state = 'appended' AND i.appended_uid IS NOT NULL`
        )
        .all(run.accountId, run.jobId, path, uidvalidity) as { fp: string; uid: number }[]) {
        prev.set(r.fp, [...(prev.get(r.fp) ?? []), r.uid])
      }

      // c) odtlačky obsahu správ na serveri: z lokálnej kópie, chýbajúce sa stiahnu po dávkach
      //    (len kandidáti so zhodným Message-ID / dátumom a odosielateľom).
      // Kľúč starších úloh mal na konci veľkosť – tá sa už nepoužíva.
      const keyOf = (it: ItemRow): string => it.weak_key.replace(/\|\d+$/, '')
      const fp = new Map<number, string | null>()
      const localSha = db.prepare(
        `SELECT m.uid AS uid, m.blob_sha256 AS sha FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE f.account_id = ? AND f.path = ? AND f.uidvalidity = ? AND m.blob_sha256 IS NOT NULL`
      )
      const localByUid = new Map((localSha.all(run.accountId, path, uidvalidity) as { uid: number; sha: string }[]).map((r) => [r.uid, r.sha]))
      const localFp = (uid: number): string | null => {
        const sha = localByUid.get(uid)
        return sha && deps.blobs.has(sha) ? sha256(canonicalize(deps.blobs.read(sha))) : null
      }
      const wanted = new Set<number>()
      for (const it of list) if (!done.has(it.seq)) for (const uid of byKey.get(keyOf(it)) ?? []) if (!consumed.has(uid)) wanted.add(uid)
      const toFetch: number[] = []
      for (const uid of wanted) {
        const f = localFp(uid)
        if (f) fp.set(uid, f)
        else toFetch.push(uid)
      }
      for (let i = 0; i < toFetch.length; i += FETCH_CHUNK) {
        isAbort(run.signal)
        const chunk = toFetch.slice(i, i + FETCH_CHUNK)
        for await (const m of c.fetch(chunk.join(','), { uid: true, source: true }, { uid: true })) {
          if (m.source) fp.set(m.uid, sha256(canonicalize(m.source)))
        }
      }
      // Záloha pre správy, ktorých kľúč sa nezhoduje (napr. nezvyčajné Message-ID): obsah lokálnej kópie priečinka.
      let localIndex: Map<string, number[]> | null = null
      const byLocalContent = (fingerprint: string): number[] => {
        if (!localIndex) {
          localIndex = new Map()
          for (const uid of localByUid.keys()) {
            if (!onServer.has(uid)) continue
            const f = fp.get(uid) ?? localFp(uid)
            if (f) localIndex.set(f, [...(localIndex.get(f) ?? []), uid])
          }
        }
        return localIndex.get(fingerprint) ?? []
      }

      for (const it of list) {
        if (done.has(it.seq)) continue
        isAbort(run.signal)
        let match: number | null = null
        for (const uid of prev.get(it.fingerprint) ?? []) {
          if (onServer.has(uid) && !consumed.has(uid)) {
            match = uid
            break
          }
        }
        if (match === null) {
          for (const uid of byKey.get(keyOf(it)) ?? []) {
            if (!consumed.has(uid) && fp.get(uid) === it.fingerprint) {
              match = uid
              break
            }
          }
        }
        if (match === null) {
          for (const uid of byLocalContent(it.fingerprint)) {
            if (!consumed.has(uid)) {
              match = uid
              break
            }
          }
        }
        if (match !== null) {
          consumed.add(match)
          if (it.state === 'appending') update(it, 'appended', { uid: match, uidvalidity })
          else if (it.state === 'pending') update(it, 'duplicate')
        } else if (it.state === 'appending') {
          update(it, 'pending')
        }
      }
    } finally {
      lock.release()
    }
  }

  async function addGmailLabels(c: ImapFlow, path: string, uid: number, labels: string[]): Promise<void> {
    const own = path === 'INBOX' ? '\\Inbox' : path
    const extra = labels.filter((l) => l !== own && l !== '\\Starred' && l !== '\\Draft' && l !== '\\Sent')
    if (!extra.length) return
    try {
      const lock = await c.getMailboxLock(path)
      try {
        await c.messageFlagsAdd(String(uid), extra, { uid: true, useLabels: true })
      } finally {
        lock.release()
      }
    } catch (e) {
      if (!c.usable) throw e
      log.warn('štítky Gmailu sa nepodarilo nastaviť', { account: run.accountId })
    }
  }

  function finish(errorCode: string | null, resumable = true): ImportSummary {
    const rows = items()
    const cancelled = errorCode === 'cancelled'
    const folders = new Map<string, ImportFolderSummary>()
    const special = new Map(deps.store.folderRows(run.accountId).map((f) => [f.path, f.special_use]))
    const failures = new Map<string, number>()
    const totals = { total: 0, uploaded: 0, duplicate: 0, failed: 0, pending: 0 }
    let skipped = 0
    for (const r of rows) {
      if (r.state === 'skipped') {
        skipped++
        continue
      }
      const key = r.target_folder ?? ''
      const f = folders.get(key) ?? { path: cfg.delimiter ? key.split(cfg.delimiter).join(' / ') : key, specialUse: special.get(key) ?? (key === 'INBOX' ? 'inbox' : null), total: 0, uploaded: 0, duplicate: 0, failed: 0, pending: 0 }
      f.total++
      totals.total++
      if (r.state === 'appended') (f.uploaded++, totals.uploaded++)
      else if (r.state === 'duplicate') (f.duplicate++, totals.duplicate++)
      else if (r.state === 'failed') {
        f.failed++
        totals.failed++
        failures.set(r.error ?? 'APPEND_REJECTED', (failures.get(r.error ?? 'APPEND_REJECTED') ?? 0) + 1)
      } else (f.pending++, totals.pending++)
      folders.set(key, f)
    }
    const counts = db
      .prepare(`SELECT SUM(changed_outside) AS ch, SUM(foreign_format) AS fo FROM import_items WHERE job_id = ? AND state <> 'skipped'`)
      .get(run.jobId) as { ch: number | null; fo: number | null }
    const result: ImportSummary['result'] = cancelled ? 'cancelled' : errorCode ? (resumable ? 'stopped' : 'failed') : totals.failed ? 'partial' : 'complete'
    const summary: ImportSummary = {
      jobId: run.jobId,
      accountId: run.accountId,
      email: acc!.email,
      fileName: cfg.fileName,
      mode: cfg.mode,
      result,
      errorCode: cancelled ? null : errorCode,
      startedAt: cfg.startedAt,
      finishedAt: new Date().toISOString(),
      folders: [...folders.values()].filter((f) => f.path !== ''),
      totals,
      changedOutside: counts.ch ?? 0,
      foreign: counts.fo ?? 0,
      keywordsDropped,
      skipped,
      failures: [...failures].map(([code, count]) => ({ code, count })),
      resumable: (result === 'stopped' || result === 'cancelled') && resumable
    }
    log.info('obnova skončila', { account: run.accountId, result, ...totals })
    return summary
  }
}

/**
 * Cieľové priečinky na serveri. Chýbajúce sa založia (aj nadradené). Existujúci priečinok sa použije tak, ako je –
 * nič sa v ňom neprepisuje ani nemaže.
 */
async function resolveTargets(
  deps: ImportDeps,
  accountId: number,
  c: ImapFlow,
  cfg: ImportConfig,
  descs: string[],
  gmailTarget: boolean
): Promise<{ map: Map<string, string>; delimiter: string }> {
  let list: ListResponse[] = await c.list()
  const delim = c.namespace?.delimiter || list.find((f) => f.delimiter)?.delimiter || '/'
  const prefix = c.namespace?.prefix || ''
  const norm = (segs: string[]): string => {
    const clean = segs.map((s) => (delim ? s.split(delim).join('_') : s))
    const p = clean.join(delim)
    if (p.toUpperCase() === 'INBOX') return 'INBOX'
    const q = clean[0]!.toUpperCase() === 'INBOX' ? `INBOX${p.slice(5)}` : p
    return prefix && !q.startsWith(prefix) ? prefix + q : q
  }
  const find = (p: string): ListResponse | undefined => list.find((f) => f.path === p) ?? list.find((f) => f.path.toLowerCase() === p.toLowerCase())
  let created = false
  const createdSpecial: [string, SpecialUse][] = []

  const ensurePath = async (segs: string[]): Promise<string> => {
    const full = norm(segs)
    const hit = find(full)
    if (hit) return hit.path
    for (let i = 1; i <= segs.length; i++) {
      const sub = norm(segs.slice(0, i))
      if (find(sub)) continue
      try {
        await c.mailboxCreate(sub)
      } catch (e) {
        if (!c.usable) throw e
        // Priečinok môže existovať (iný zápis názvu) – overí sa novým zoznamom.
      }
      created = true
    }
    list = await c.list()
    const after = find(full)
    if (!after) throw new ImportFailure('FOLDER_CREATE_FAILED', 'Server priečinok nevytvoril')
    return after.path
  }

  const special = async (use: SpecialUse): Promise<string> => {
    if (use === 'inbox') return 'INBOX'
    if (gmailTarget && use === 'archive') {
      const all = list.find((f) => f.specialUse === '\\All')
      if (all) return all.path
    }
    const local = deps.store.specialFolder(accountId, use)
    if (local && find(local.path)) return find(local.path)!.path
    const srv = list.find((f) => f.specialUse === FLAG_FROM_SPECIAL[use])
    if (srv) return srv.path
    const name = DEFAULT_NAMES[use as keyof typeof DEFAULT_NAMES] ?? use
    const path = await ensurePath([name])
    createdSpecial.push([path, use])
    return path
  }

  const out = new Map<string, string>()
  for (const d of descs) {
    if (d === 'fallback') {
      if ('folderPath' in cfg.target) {
        const hit = find(cfg.target.folderPath)
        out.set(d, hit ? hit.path : await ensurePath(cfg.target.folderPath.split(delim)))
      } else out.set(d, await ensurePath([cfg.target.newName]))
    } else if (d.startsWith('special:')) {
      out.set(d, await special(d.slice(8) as SpecialUse))
    } else if (d.startsWith('path:')) {
      const segs = decodeFolderPath(d.slice(5))
      out.set(d, segs.length ? await ensurePath(segs) : 'INBOX')
    }
  }
  if (created) {
    deps.store.syncFolders(accountId, list.map(toFolderInfo))
    for (const [path, use] of createdSpecial) deps.store.markSpecialUse(accountId, path, use)
    deps.emit('folders.changed', { accountId })
  }
  return { map: out, delimiter: delim }
}
