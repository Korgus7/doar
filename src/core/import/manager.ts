import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Db } from '../store/db'
import type { FileGrants } from '../files'
import type { ImportJobInfo, ImportMode, ImportPeek, ImportProgress, ImportState, ImportSummary, ImportTarget } from '../../shared/ipc'
import { importToAccount, type ImportConfig, type ImportDeps } from './import-account'
import { NotMboxError, peekMbox } from './mbox-reader'

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const now = (): string => new Date().toISOString()

/**
 * Obnova zo zálohy do konta. Súbor smie byť len ten, ktorý používateľ vybral v natívnom dialógu.
 * Naraz beží jedna obnova; prerušená (zrušená, bez spojenia, plná schránka, pád aplikácie) sa dá dokončiť.
 */
export class ImportManager {
  private running: { jobId: number; accountId: number; controller: AbortController; progress: ImportProgress | null; promise: Promise<ImportSummary> } | null = null
  private last: ImportSummary | null = null

  constructor(
    private readonly deps: ImportDeps & { files: FileGrants },
    private readonly testHooks: { beforeAppend?: (seq: number) => Promise<void> } = {}
  ) {
    this.recoverInterrupted()
  }

  /** Obnova prerušená pádom aplikácie: dá sa v nej pokračovať. Nejasné nahrávanie sa overí pri pokračovaní. */
  private recoverInterrupted(): void {
    this.deps.db
      .prepare(`UPDATE jobs SET state = 'interrupted', summary_json = COALESCE(summary_json, ?) WHERE kind = 'import' AND state = 'running'`)
      .run(JSON.stringify({ errorCode: 'APP_CLOSED' }))
  }

  async peek(path: string): Promise<ImportPeek> {
    const p = await this.deps.files.require(path, 'read')
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) throw err('FILE_MISSING', 'Súbor sa nenašiel')
    try {
      const info = await peekMbox(p)
      return { path: p, name: basename(p), sizeBytes: st.size, doar: info.doar, source: info.source }
    } catch (e) {
      if (e instanceof NotMboxError) throw err('NOT_MBOX', 'Súbor nie je vo formáte mbox')
      throw e
    }
  }

  async start(input: { accountId: number; path: string; mode: ImportMode; target: ImportTarget }): Promise<{ jobId: number }> {
    const accountId = Number(input?.accountId)
    if (!Number.isInteger(accountId) || !this.deps.db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId)) throw err('NO_ACCOUNT', 'Konto neexistuje')
    if (this.running) throw err('IMPORT_RUNNING', 'Obnova už prebieha')
    const mode: ImportMode = input?.mode === 'restore' ? 'restore' : 'single'
    const path = await this.deps.files.require(typeof input?.path === 'string' ? input.path : '', 'read')
    const st = await stat(path).catch(() => null)
    if (!st?.isFile()) throw err('FILE_MISSING', 'Súbor sa nenašiel')

    let target: ImportConfig['target']
    const t = input?.target as { folderId?: unknown; newName?: unknown } | undefined
    if (Number.isInteger(t?.folderId)) {
      const f = this.deps.store.folder(t!.folderId as number)
      if (!f || f.account_id !== accountId || !f.selectable) throw err('NO_TARGET', 'Cieľový priečinok neexistuje')
      target = { folderPath: f.path }
    } else {
      const name = typeof t?.newName === 'string' ? t.newName.trim() : ''
      if (!name || name.length > 200 || /[%*\u0000-\u001f]/.test(name)) throw err('INVALID_FOLDER_NAME', 'Neplatný názov priečinka')
      target = { newName: name }
    }
    const cfg: ImportConfig = { path, fileName: basename(path), fileSize: st.size, fileMtimeMs: st.mtimeMs, mode, target, scanned: false, startedAt: now() }
    const jobId = (this.deps.db
      .prepare(`INSERT INTO jobs (kind, account_id, state, started_at, progress_json) VALUES ('import', ?, 'running', ?, ?) RETURNING id`)
      .get(accountId, cfg.startedAt, JSON.stringify(cfg)) as { id: number }).id
    this.launch(jobId, accountId)
    return { jobId }
  }

  resume(jobId: number): { jobId: number } {
    if (this.running) throw err('IMPORT_RUNNING', 'Obnova už prebieha')
    const job = this.deps.db.prepare(`SELECT account_id FROM jobs WHERE id = ? AND kind = 'import' AND state = 'interrupted'`).get(jobId) as { account_id: number } | undefined
    if (!job) throw err('NOT_FOUND', 'Obnova sa nenašla')
    if (!this.deps.db.prepare('SELECT id FROM accounts WHERE id = ?').get(job.account_id)) throw err('NO_ACCOUNT', 'Konto neexistuje')
    this.deps.db.prepare(`UPDATE jobs SET state = 'running', finished_at = NULL, summary_json = NULL WHERE id = ?`).run(jobId)
    this.launch(jobId, job.account_id)
    return { jobId }
  }

  private launch(jobId: number, accountId: number): void {
    const controller = new AbortController()
    const entry = { jobId, accountId, controller, progress: null as ImportProgress | null, promise: Promise.resolve(null as unknown as ImportSummary) }
    this.running = entry
    this.deps.emit('import.changed', null)
    entry.promise = importToAccount(this.deps, {
      jobId,
      accountId,
      signal: controller.signal,
      beforeAppend: this.testHooks.beforeAppend,
      onProgress: (p) => {
        entry.progress = p
        this.deps.emit('import.progress', p)
      }
    })
      .catch((e: unknown): ImportSummary => {
        // Neočakávaná chyba mimo postupu (napr. konto medzitým odstránené).
        const code = (e as { code?: string })?.code ?? 'UNKNOWN'
        return {
          jobId,
          accountId,
          email: '',
          fileName: '',
          mode: 'single',
          result: 'failed',
          errorCode: code,
          startedAt: now(),
          finishedAt: now(),
          folders: [],
          totals: { total: 0, uploaded: 0, duplicate: 0, failed: 0, pending: 0 },
          changedOutside: 0,
          foreign: 0,
          keywordsDropped: 0,
          skipped: 0,
          failures: [],
          resumable: false
        }
      })
      .then((summary) => {
        this.running = null
        this.last = summary
        const state = summary.resumable ? 'interrupted' : summary.result === 'failed' ? 'failed' : 'done'
        this.deps.db.prepare(`UPDATE jobs SET state = ?, finished_at = ?, summary_json = ? WHERE id = ?`).run(state, summary.finishedAt, JSON.stringify(summary), jobId)
        this.deps.emit('import.finished', summary)
        this.deps.emit('import.changed', null)
        return summary
      })
  }

  cancel(jobId: number): void {
    if (this.running?.jobId === jobId) this.running.controller.abort()
  }

  /** Zabudnúť prerušenú obnovu. Správy, ktoré už sú na serveri, tam zostanú. */
  discard(jobId: number): void {
    if (this.running?.jobId === jobId) throw err('IMPORT_RUNNING', 'Obnova práve prebieha')
    this.deps.db.prepare(`UPDATE jobs SET state = 'discarded' WHERE id = ? AND kind = 'import' AND state = 'interrupted'`).run(jobId)
    this.deps.emit('import.changed', null)
  }

  /** Pre testy: počká na dokončenie úlohy. */
  wait(jobId: number): Promise<ImportSummary> | undefined {
    return this.running?.jobId === jobId ? this.running.promise : undefined
  }

  state(): ImportState {
    const rows = this.deps.db
      .prepare(
        `SELECT j.id, j.account_id, j.started_at, j.progress_json, j.summary_json, a.email FROM jobs j JOIN accounts a ON a.id = j.account_id
         WHERE j.kind = 'import' AND j.state = 'interrupted' ORDER BY j.id DESC LIMIT 20`
      )
      .all() as { id: number; account_id: number; started_at: string; progress_json: string; summary_json: string | null; email: string }[]
    const resumable: ImportJobInfo[] = rows.map((r) => {
      const cfg = JSON.parse(r.progress_json) as Partial<ImportConfig>
      const sum = r.summary_json ? (JSON.parse(r.summary_json) as Partial<ImportSummary>) : null
      return {
        jobId: r.id,
        accountId: r.account_id,
        email: r.email,
        fileName: cfg.fileName ?? '',
        startedAt: r.started_at,
        errorCode: sum?.errorCode ?? null,
        totals: sum?.totals ?? null
      }
    })
    return { running: this.running?.progress ?? null, last: this.last, resumable }
  }

  async cancelAll(): Promise<void> {
    const r = this.running
    if (!r) return
    r.controller.abort()
    await r.promise.catch(() => {})
  }
}
