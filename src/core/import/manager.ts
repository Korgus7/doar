import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Db } from '../store/db'
import type { FileGrants } from '../files'
import type { ImportFormat, ImportJobInfo, ImportMode, ImportPeek, ImportProgress, ImportState, ImportSummary, ImportTarget } from '../../shared/ipc'
import { importToAccount, type ImportConfig, type ImportDeps } from './import-account'
import { NotMboxError, peekMbox } from './mbox-reader'
import { detectSource, sourceInfo } from './sources'

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
    private readonly deps: ImportDeps & { files: FileGrants; workDir?: string },
    private readonly testHooks: { beforeAppend?: (seq: number) => Promise<void> } = {}
  ) {
    this.recoverInterrupted()
    this.cleanWork()
  }

  /** Dočasný súbor prevodu (Outlook, Outlook Express, Windows Mail) pre úlohu. */
  private tmpWork: string | null = null
  /** Priečinok dočasných súborov prevodu (v aplikácii v dátovom priečinku, v testoch vlastný dočasný). */
  private get workDir(): string {
    return this.deps.workDir ?? (this.tmpWork ??= mkdtempSync(join(tmpdir(), 'doar-import-')))
  }

  private workFile(jobId: number): string {
    return join(this.workDir, `import-${jobId}.mbox`)
  }

  /** Dočasné súbory prevodu, ktoré už nepatria žiadnej nedokončenej obnove, sa zmažú. */
  private cleanWork(): void {
    try {
      mkdirSync(this.workDir, { recursive: true })
      const keep = new Set(
        (this.deps.db.prepare(`SELECT id FROM jobs WHERE kind = 'import' AND state IN ('interrupted', 'running')`).all() as { id: number }[]).map((r) => `import-${r.id}.mbox`)
      )
      for (const name of readdirSync(this.workDir)) if (!keep.has(name)) rmSync(join(this.workDir, name), { force: true })
    } catch {
      /* priečinok sa nedá čítať – nič nemažeme */
    }
  }

  /** Obnova prerušená pádom aplikácie: dá sa v nej pokračovať. Nejasné nahrávanie sa overí pri pokračovaní. */
  private recoverInterrupted(): void {
    this.deps.db
      .prepare(`UPDATE jobs SET state = 'interrupted', summary_json = COALESCE(summary_json, ?) WHERE kind = 'import' AND state = 'running'`)
      .run(JSON.stringify({ errorCode: 'APP_CLOSED' }))
  }

  async peek(path: string): Promise<ImportPeek> {
    const p = await this.deps.files.require(path, ['read', 'tree'])
    const st = await stat(p).catch(() => null)
    if (!st) throw err('FILE_MISSING', 'Súbor sa nenašiel')
    const format = await this.formatOf(p, st.isDirectory())
    if (format !== 'mbox') {
      const info = await sourceInfo(format, p).catch((e: unknown) => {
        throw err((e as { code?: string }).code ?? 'NOT_SUPPORTED', 'Súbor sa nedá prečítať')
      })
      if (!info.messages) throw err('NO_MESSAGES', 'Nenašli sa žiadne správy')
      return { path: p, name: basename(p), sizeBytes: st.isFile() ? st.size : 0, doar: false, source: null, format, messages: info.messages, folders: info.folders }
    }
    try {
      const info = await peekMbox(p)
      return { path: p, name: basename(p), sizeBytes: st.size, doar: info.doar, source: info.source, format, messages: null, folders: null }
    } catch (e) {
      if (e instanceof NotMboxError) throw err('NOT_MBOX', 'Súbor nie je vo formáte mbox')
      throw e
    }
  }

  /** Formát: mbox, alebo pošta iného programu (priečinok Windows Mail / Outlook Express, súbor .pst/.ost/.dbx/.eml). */
  private async formatOf(path: string, isDir: boolean): Promise<ImportFormat> {
    if (!isDir && /^\.(mbox|mbx)$/i.test(extname(path))) return 'mbox'
    const f = await detectSource(path)
    if (f) return f
    if (isDir) throw err('NOT_SUPPORTED', 'V priečinku nie je pošta Outlook Express ani Windows Mail')
    return 'mbox'
  }

  async start(input: { accountId: number; path: string; mode: ImportMode; target: ImportTarget }): Promise<{ jobId: number }> {
    const accountId = Number(input?.accountId)
    if (!Number.isInteger(accountId) || !this.deps.db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId)) throw err('NO_ACCOUNT', 'Konto neexistuje')
    if (this.running) throw err('IMPORT_RUNNING', 'Obnova už prebieha')
    const mode: ImportMode = input?.mode === 'restore' ? 'restore' : 'single'
    const path = await this.deps.files.require(typeof input?.path === 'string' ? input.path : '', ['read', 'tree'])
    const st = await stat(path).catch(() => null)
    if (!st) throw err('FILE_MISSING', 'Súbor sa nenašiel')
    const format = await this.formatOf(path, st.isDirectory())

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
    if (format !== 'mbox') {
      // Pošta iného programu sa najprv prevedie do dočasného súboru vo formáte zálohy Doar.
      mkdirSync(this.workDir, { recursive: true })
      cfg.source = { format, path, size: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs }
      cfg.path = this.workFile(jobId)
      cfg.fileSize = 0
      this.deps.db.prepare(`UPDATE jobs SET progress_json = ? WHERE id = ?`).run(JSON.stringify(cfg), jobId)
    }
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
        if (state !== 'interrupted') rmSync(this.workFile(jobId), { force: true })
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
    rmSync(this.workFile(jobId), { force: true })
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
