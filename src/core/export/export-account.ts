import type { ImapFlow, ListResponse } from 'imapflow'
import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import type { Db } from '../store/db'
import type { BlobStore } from '../store/blobs'
import type { MailStore } from '../store/mailstore'
import type { ExportFolderSummary, ExportPhase, ExportProgress, ExportSummary } from '../../shared/ipc'
import { incompletePath } from '../../shared/ipc'
import { encodeMessage, type MessageMeta, type SpecialUseFlag } from './mboxrd'
import { BlobStore as Blobs } from '../store/blobs'
import { indexInfo } from '../mail/parse'
import { classifyError } from '../mail/connection-test'
import { logger } from '../log'
import type { GraphClient, GraphError } from '../graph/client'
import { graphFolderTree, wellKnownIds } from '../graph/folders'

const log = logger('export')

const CHUNK_MAX_MESSAGES = 25
const CHUNK_MAX_BYTES = 20 * 1024 * 1024
const RECONNECT_DELAYS = [2000, 5000, 10000]
const MAX_LINE = 998

/** Súborové operácie – oddelené, aby sa dali v testoch nahradiť (plný disk a pod.). */
export interface FsOps {
  open(path: string): Promise<{ write(buf: Buffer): Promise<unknown>; sync(): Promise<void>; close(): Promise<void> }>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  stat(path: string): Promise<{ size: number }>
  /** Voľné miesto v priečinku (bajty). */
  freeSpace(dir: string): Promise<number>
}

export const realFs: FsOps = {
  async open(path) {
    const h = await fsp.open(path, 'w')
    return {
      write: (buf: Buffer) => h.write(buf),
      sync: () => h.sync(),
      close: () => h.close()
    }
  },
  rename: (a, b) => fsp.rename(a, b),
  unlink: (p) => fsp.unlink(p),
  stat: (p) => fsp.stat(p),
  async freeSpace(dir) {
    const s = await fsp.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  }
}

export interface ExportDeps {
  db: Db
  store: MailStore
  blobs: BlobStore
  /** Nové nepripojené IMAP spojenie pre konto. */
  newClient(accountId: number): Promise<ImapFlow>
  /** Konto cez Microsoft Graph (Outlook.com, Microsoft 365): klient Graph namiesto IMAP. */
  graphClient?(accountId: number): GraphClient
  fs?: FsOps
}

export interface ExportRun {
  jobId: number
  accountId: number
  path: string
  signal: AbortSignal
  onProgress(p: ExportProgress): void
  /** Len pre testy: zavolá sa po snímke, pred sťahovaním a zápisom. */
  afterSnapshot?: () => Promise<void>
}

interface Item {
  uid: number
  /** Graph: ID správy u poskytovateľa (uid je potom len poradie). */
  remoteId?: string
  size: number
  internalDate: Date | null
  flags: Set<string>
  labels: string[] | undefined
  sha: string | null
  localId: number | null
  localHasBody: boolean
  state: 'pending' | 'unavailable' | 'failed' | 'exported'
}

interface FolderSnap {
  path: string
  /** Graph: priečinok je ID v Graph (path = to isté ID). */
  graph?: boolean
  segments: string[]
  specialUse: SpecialUseFlag | null
  uidvalidity: number
  items: Item[]
}

const SPECIAL: Record<string, SpecialUseFlag> = {
  '\\Inbox': '\\Inbox',
  '\\Sent': '\\Sent',
  '\\Drafts': '\\Drafts',
  '\\Trash': '\\Trash',
  '\\Junk': '\\Junk',
  '\\Archive': '\\Archive',
  '\\All': '\\All'
}

class Cancelled extends Error {
  constructor() {
    super('Záloha bola zrušená')
  }
}

class ExportFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/**
 * Výber priečinkov na zálohu. Gmail: každá správa je vo „Všetkej pošte“ – exportuje sa len
 * Všetka pošta, Kôš a Spam (inak by sa tá istá správa uložila za každý štítok znova).
 */
export function selectFolders(list: ListResponse[], gmail: boolean): ListResponse[] {
  const selectable = list.filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'))
  const chosen = gmail ? selectable.filter((f) => f.specialUse === '\\All' || f.specialUse === '\\Trash' || f.specialUse === '\\Junk') : selectable
  return chosen.sort((a, b) => (a.specialUse === '\\Inbox' ? -1 : b.specialUse === '\\Inbox' ? 1 : a.path.localeCompare(b.path)))
}

function isAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Cancelled()
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Cancelled())), { once: true })
  })

/**
 * Záloha jedného konta do súboru mboxrd (docs/MBOX-METADATA.md).
 * Postup: 1. snímka priečinkov a UID, 2. kontrola lokálnej kópie, 3. stiahnutie chýbajúcich originálov,
 * 4. zápis do „.part“ a premenovanie až po úspechu.
 */
export async function exportAccount(deps: ExportDeps, run: ExportRun): Promise<ExportSummary> {
  const fs = deps.fs ?? realFs
  const startedAt = new Date().toISOString()
  const acc = deps.db.prepare('SELECT email, provider_key, protocol FROM accounts WHERE id = ?').get(run.accountId) as
    | { email: string; provider_key: string | null; protocol: 'imap' | 'graph' }
    | undefined
  if (!acc) throw new ExportFailure('NO_ACCOUNT', 'Konto neexistuje')
  const graphMode = acc.protocol === 'graph'
  const partPath = `${run.path}.part`
  const progress: ExportProgress = {
    jobId: run.jobId,
    accountId: run.accountId,
    phase: 'scan',
    foldersDone: 0,
    foldersTotal: 0,
    messagesTotal: 0,
    missing: 0,
    downloaded: 0,
    written: 0,
    bytes: 0
  }
  let lastEmit = 0
  const emit = (phase?: ExportPhase, force = false): void => {
    if (phase) progress.phase = phase
    const now = Date.now()
    if (!force && !phase && now - lastEmit < 200) return
    lastEmit = now
    run.onProgress({ ...progress })
  }

  let client: ImapFlow | null = null
  let gmail = acc.provider_key === 'gmail'
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
        if (c.capabilities.has('X-GM-EXT-1')) gmail = true
        return c
      } catch (e) {
        lastErr = e
        const code = classifyError(e).code
        // Zlé heslo alebo certifikát sa opakovaním nezlepší.
        if (code === 'AUTH_FAILED' || code?.startsWith('CERT_') || (e as { code?: string }).code === 'PASSWORD_REQUIRED') break
        if (attempt < RECONNECT_DELAYS.length) await sleep(RECONNECT_DELAYS[attempt]!, run.signal)
      }
    }
    const code = (lastErr as { code?: string })?.code === 'PASSWORD_REQUIRED' ? 'PASSWORD_REQUIRED' : (classifyError(lastErr).code ?? 'UNKNOWN')
    throw new ExportFailure(code, 'Nepodarilo sa pripojiť k serveru')
  }

  async function snapshotImap(): Promise<void> {
    const c0 = await connect()
    const list = selectFolders(await c0.list(), gmail)
    progress.foldersTotal = list.length
    emit(undefined, true)
    for (const f of list) {
      isAbort(run.signal)
      const c = await connect()
      const lock = await c.getMailboxLock(f.path, { readOnly: true })
      try {
        const mb = c.mailbox
        if (!mb) continue
        const snap: FolderSnap = {
          path: f.path,
          segments: [...f.parent, f.name],
          specialUse: f.specialUse ? (SPECIAL[f.specialUse] ?? null) : null,
          uidvalidity: Number(mb.uidValidity),
          items: []
        }
        if (mb.exists > 0) {
          for await (const m of c.fetch('1:*', { uid: true, flags: true, internalDate: true, size: true, ...(gmail ? { labels: true } : {}) })) {
            const d = m.internalDate ? new Date(m.internalDate) : null
            snap.items.push({
              uid: m.uid,
              size: m.size ?? 0,
              internalDate: d && !Number.isNaN(d.getTime()) ? d : null,
              flags: new Set([...(m.flags ?? [])].filter((x) => x !== '\\Recent' && x !== '\\Deleted')),
              labels: m.labels ? [...m.labels] : undefined,
              sha: null,
              localId: null,
              localHasBody: false,
              state: 'pending'
            })
          }
          snap.items.sort((a, b) => a.uid - b.uid)
        }
        folders.push(snap)
      } finally {
        lock.release()
      }
      progress.foldersDone++
      progress.messagesTotal += folders.at(-1)?.items.length ?? 0
      emit()
    }
  }

  /** Graph: strom priečinkov a zoznam správ priamo zo servera (nie z lokálnej databázy – môže byť neúplná). */
  async function snapshotGraph(): Promise<void> {
    const known = await gcall((g) => wellKnownIds(g))
    const tree = await gcall((g) => graphFolderTree(g, known))
    const byId = new Map(tree.map((f) => [f.id, f]))
    const segments = (id: string): string[] => {
      const out: string[] = []
      for (let f = byId.get(id), i = 0; f && i < 64; f = f.parent ? byId.get(f.parent) : undefined, i++) out.unshift(f.name)
      return out
    }
    const flagOf: Record<string, SpecialUseFlag> = { inbox: '\\Inbox', sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', junk: '\\Junk', archive: '\\Archive' }
    const ordered = [...tree].sort((a, b) => (a.specialUse === 'inbox' ? -1 : b.specialUse === 'inbox' ? 1 : segments(a.id).join('/').localeCompare(segments(b.id).join('/'))))
    progress.foldersTotal = ordered.length
    emit(undefined, true)
    for (const f of ordered) {
      isAbort(run.signal)
      type M = { id: string; receivedDateTime?: string; isRead?: boolean; isDraft?: boolean; flag?: { flagStatus?: string } }
      const list = await gcall((g) => g.getAll<M>(`/me/mailFolders/${encodeURIComponent(f.id)}/messages?$select=id,receivedDateTime,isRead,isDraft,flag&$top=500`))
      const items: Item[] = list.map((m, i) => {
        const d = m.receivedDateTime ? new Date(m.receivedDateTime) : null
        const flags = new Set<string>()
        if (m.isRead) flags.add('\\Seen')
        if (m.flag?.flagStatus === 'flagged') flags.add('\\Flagged')
        if (m.isDraft) flags.add('\\Draft')
        return { uid: i + 1, remoteId: m.id, size: 0, internalDate: d && !Number.isNaN(d.getTime()) ? d : null, flags, labels: undefined, sha: null, localId: null, localHasBody: false, state: 'pending' }
      })
      folders.push({ path: f.id, graph: true, segments: segments(f.id), specialUse: f.specialUse ? (flagOf[f.specialUse] ?? null) : null, uidvalidity: 0, items })
      progress.foldersDone++
      progress.messagesTotal += items.length
      emit()
    }
  }

  // Graph: požiadavka s opakovaním pri výpadku spojenia (ako pri IMAP).
  let graph: GraphClient | null = null
  const gcall = async <T>(fn: (g: GraphClient) => Promise<T>): Promise<T> => {
    if (!graph) {
      if (!deps.graphClient) throw new ExportFailure('GRAPH_UNSUPPORTED', 'Záloha cez Microsoft Graph nie je dostupná')
      graph = deps.graphClient(run.accountId)
    }
    for (let attempt = 0; ; attempt++) {
      isAbort(run.signal)
      try {
        return await fn(graph)
      } catch (e) {
        const code = (e as GraphError).code ?? 'UNKNOWN'
        if ((code === 'NO_NETWORK' || code === 'TIMEOUT') && attempt < RECONNECT_DELAYS.length) {
          await sleep(RECONNECT_DELAYS[attempt]!, run.signal)
          continue
        }
        throw e
      }
    }
  }

  const folders: FolderSnap[] = []
  let partCreated = false
  try {
    // ---------- 1. snímka ----------
    emit('scan', true)
    if (graphMode) await snapshotGraph()
    else await snapshotImap()
    await run.afterSnapshot?.()

    // ---------- 2. kontrola lokálnej kópie ----------
    emit('check', true)
    for (const f of folders) {
      if (f.graph) {
        const rows = deps.db
          .prepare(
            `SELECT m.id, m.remote_id AS remote, m.blob_sha256 AS sha, m.answered FROM messages m JOIN folders fo ON fo.id = m.folder_id
             WHERE fo.account_id = ? AND fo.path = ? AND m.remote_id IS NOT NULL`
          )
          .all(run.accountId, f.path) as { id: number; remote: string; sha: string | null; answered: number }[]
        const byRemote = new Map(rows.map((r) => [r.remote, r]))
        for (const it of f.items) {
          const r = byRemote.get(it.remoteId!)
          if (!r) continue
          it.localId = r.id
          it.localHasBody = !!r.sha
          if (r.sha && deps.blobs.has(r.sha)) it.sha = r.sha
          // „Odpovedané“ Graph nepozná – pamätá si ho Doar.
          if (r.answered) it.flags.add('\\Answered')
        }
        progress.missing += f.items.filter((i) => !i.sha).length
        continue
      }
      const rows = deps.db
        .prepare(
          `SELECT m.id, m.uid, m.blob_sha256 AS sha FROM messages m JOIN folders fo ON fo.id = m.folder_id
           WHERE fo.account_id = ? AND fo.path = ? AND fo.uidvalidity = ?`
        )
        .all(run.accountId, f.path, f.uidvalidity) as { id: number; uid: number; sha: string | null }[]
      const byUid = new Map(rows.map((r) => [r.uid, r]))
      for (const it of f.items) {
        const r = byUid.get(it.uid)
        if (!r) continue
        it.localId = r.id
        it.localHasBody = !!r.sha
        if (r.sha && deps.blobs.has(r.sha)) it.sha = r.sha
      }
      progress.missing += f.items.filter((i) => !i.sha).length
    }
    emit(undefined, true)

    // Voľné miesto: odhad = veľkosť správ × 1,05 + réžia na blok metadát.
    // Graph veľkosť správ v zozname neuvádza – odhad 100 kB na správu.
    const estimate = Math.ceil(folders.reduce((s, f) => s + f.items.reduce((t, i) => t + (f.graph ? 100 * 1024 : i.size), 0), 0) * 1.05) + progress.messagesTotal * 1024
    const free = await fs.freeSpace(dirname(run.path)).catch(() => Number.POSITIVE_INFINITY)
    if (free < estimate) throw new ExportFailure('DISK_FULL', 'Na disku nie je dosť miesta pre zálohu')

    // ---------- 3. stiahnutie chýbajúcich originálov ----------
    emit('download', true)
    const download = async (f: FolderSnap, items: Item[]): Promise<void> => {
      if (!items.length) return
      if (f.graph) return downloadGraph(items)
      for (let attempt = 0; ; attempt++) {
        isAbort(run.signal)
        const c = await connect()
        try {
          const lock = await c.getMailboxLock(f.path, { readOnly: true })
          try {
            if (Number(c.mailbox && c.mailbox.uidValidity) !== f.uidvalidity) {
              // Priečinok bol nahradený – správy zo snímky už na serveri nie sú.
              for (const it of f.items) if (!it.sha) it.state = 'unavailable'
              return
            }
            const byUid = new Map(items.map((i) => [i.uid, i]))
            const got = new Set<number>()
            for await (const m of c.fetch(items.map((i) => i.uid).join(','), { uid: true, source: true }, { uid: true })) {
              const it = byUid.get(m.uid)
              if (!it || !m.source) continue
              got.add(m.uid)
              it.sha = deps.blobs.put(m.source)
              progress.downloaded++
              // Doplniť aj lokálnu kópiu pre čítanie a vyhľadávanie.
              if (it.localId && !it.localHasBody) {
                try {
                  deps.store.setBody(it.localId, it.sha, await indexInfo(m.source))
                  it.localHasBody = true
                } catch (e) {
                  log.warn('správu sa nepodarilo zaindexovať', { message: it.localId, error: e })
                }
              }
              emit()
            }
            for (const it of items) if (!got.has(it.uid)) it.state = 'unavailable' // zmazané medzičasom
          } finally {
            lock.release()
          }
          return
        } catch (e) {
          if (e instanceof Cancelled || e instanceof ExportFailure) throw e
          if (c.usable) {
            // Server odmietol príkaz (napr. priečinok medzičasom zmazaný) – správy nie sú dostupné.
            for (const it of items) if (!it.sha) it.state = 'unavailable'
            return
          }
          if (attempt >= RECONNECT_DELAYS.length) {
            for (const it of items) if (!it.sha) it.state = 'failed'
            return
          }
          log.info('spojenie počas zálohy prerušené – skúšam znova', { account: run.accountId })
        }
      }
    }
    /** Graph: originál každej správy cez /$value (zmazaná medzičasom = nedostupná). */
    const downloadGraph = async (items: Item[]): Promise<void> => {
      for (const it of items) {
        isAbort(run.signal)
        let raw: Buffer
        try {
          raw = await gcall(async (g) => (await g.request('GET', `/me/messages/${encodeURIComponent(it.remoteId!)}/$value`, { raw: true })).bytes!)
        } catch (e) {
          if (e instanceof Cancelled) throw e
          const code = (e as GraphError).code
          if (code === 'AUTH_FAILED' || code?.startsWith('OAUTH_')) throw new ExportFailure(code, 'Prihlásenie vypršalo')
          it.state = code === 'NOT_FOUND' ? 'unavailable' : 'failed'
          continue
        }
        it.sha = deps.blobs.put(raw)
        progress.downloaded++
        if (it.localId && !it.localHasBody) {
          try {
            deps.store.setBody(it.localId, it.sha, await indexInfo(raw))
            it.localHasBody = true
          } catch (e) {
            log.warn('správu sa nepodarilo zaindexovať', { message: it.localId, error: e })
          }
        }
        emit()
      }
    }
    for (const f of folders) {
      const missing = f.items.filter((i) => !i.sha && i.state === 'pending')
      let chunk: Item[] = []
      let bytes = 0
      for (const it of missing) {
        if (chunk.length && (chunk.length >= CHUNK_MAX_MESSAGES || bytes + it.size > CHUNK_MAX_BYTES)) {
          await download(f, chunk)
          chunk = []
          bytes = 0
        }
        chunk.push(it)
        bytes += it.size
      }
      await download(f, chunk)
      for (const it of f.items) if (it.state === 'pending' && !it.sha) it.state = 'failed'
    }
    emit(undefined, true)

    // ---------- 4. zápis ----------
    emit('write', true)
    const out = await fs.open(partPath).catch((e: NodeJS.ErrnoException) => {
      throw new ExportFailure(e.code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_FAILED', 'Súbor zálohy sa nepodarilo vytvoriť')
    })
    partCreated = true
    try {
      for (const f of folders) {
        for (const it of f.items) {
          isAbort(run.signal)
          if (it.state !== 'pending' || !it.sha) continue
          let raw = deps.blobs.read(it.sha)
          if (Blobs.hash(raw) !== it.sha) {
            // Poškodená lokálna kópia – stiahneme znova.
            log.warn('poškodená lokálna kópia správy – sťahujem znova', { account: run.accountId })
            it.sha = null
            await download(f, [it])
            if (!it.sha) {
              if (it.state === 'pending') it.state = 'failed'
              continue
            }
            raw = deps.blobs.read(it.sha)
          }
          const meta: MessageMeta = {
            source: acc.email,
            folderSegments: f.segments,
            specialUse: f.specialUse,
            internalDate: it.internalDate,
            flags: it.flags,
            gmailLabels: gmail ? it.labels : undefined
          }
          const { chunk } = encodeMessage(raw, meta)
          // Blok metadát nesmie mať riadok dlhší ako 998 znakov (extrémne dlhá cesta priečinka).
          const headEnd = chunk.indexOf('\nX-Doar-Hash')
          if (chunk.subarray(0, headEnd).toString('latin1').split('\n').some((l) => l.length > MAX_LINE)) {
            it.state = 'failed'
            continue
          }
          try {
            await out.write(chunk)
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code
            throw new ExportFailure(code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_FAILED', 'Zápis zálohy zlyhal')
          }
          it.state = 'exported'
          progress.written++
          progress.bytes += chunk.length
          emit()
        }
      }
      await out.sync()
    } finally {
      await out.close().catch(() => {})
    }

    // ---------- súhrn a premenovanie ----------
    const summaryFolders = folderSummary(folders)
    const totals = sumTotals(summaryFolders)
    const complete = totals.unavailable === 0 && totals.failed === 0 && totals.exported === totals.expected
    const finalPath = complete ? run.path : incompletePath(run.path)
    try {
      await fs.unlink(finalPath).catch(() => {})
      await fs.rename(partPath, finalPath)
    } catch {
      throw new ExportFailure('WRITE_FAILED', 'Súbor zálohy sa nepodarilo premenovať')
    }
    partCreated = false
    const sizeBytes = (await fs.stat(finalPath)).size
    emit(undefined, true)
    log.info('záloha dokončená', { account: run.accountId, result: complete ? 'complete' : 'incomplete', ...totals })
    return {
      jobId: run.jobId,
      accountId: run.accountId,
      email: acc.email,
      result: complete ? 'complete' : 'incomplete',
      errorCode: null,
      path: finalPath,
      startedAt,
      finishedAt: new Date().toISOString(),
      sizeBytes,
      gmail,
      downloaded: progress.downloaded,
      folders: summaryFolders,
      totals
    }
  } catch (e) {
    if (partCreated) await fs.unlink(partPath).catch(() => {})
    const cancelled = e instanceof Cancelled
    const code = cancelled ? null : e instanceof ExportFailure ? e.code : graphMode ? ((e as GraphError).code ?? 'UNKNOWN') : (classifyError(e).code ?? 'UNKNOWN')
    if (!cancelled) log.warn('záloha zlyhala', { account: run.accountId, code, error: e })
    const summaryFolders = folderSummary(folders)
    return {
      jobId: run.jobId,
      accountId: run.accountId,
      email: acc.email,
      result: cancelled ? 'cancelled' : 'failed',
      errorCode: code,
      path: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      sizeBytes: 0,
      gmail,
      downloaded: progress.downloaded,
      folders: summaryFolders,
      totals: sumTotals(summaryFolders)
    }
  } finally {
    const c = client as ImapFlow | null
    if (c) {
      await c.logout().catch(() => {})
      c.close()
    }
  }
}

function folderSummary(folders: FolderSnap[]): ExportFolderSummary[] {
  return folders.map((f) => ({
    path: f.segments.join(' / '),
    specialUse: f.specialUse,
    expected: f.items.length,
    exported: f.items.filter((i) => i.state === 'exported').length,
    unavailable: f.items.filter((i) => i.state === 'unavailable').length,
    failed: f.items.filter((i) => i.state === 'failed').length
  }))
}

function sumTotals(list: ExportFolderSummary[]): ExportSummary['totals'] {
  return list.reduce(
    (t, f) => ({ expected: t.expected + f.expected, exported: t.exported + f.exported, unavailable: t.unavailable + f.unavailable, failed: t.failed + f.failed }),
    { expected: 0, exported: 0, unavailable: 0, failed: 0 }
  )
}
