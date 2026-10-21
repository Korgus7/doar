import { existsSync, unlinkSync } from 'node:fs'
import type { Db } from '../store/db'
import type { CoreEvents, EventChannel, ExportProgress, ExportState, ExportSummary } from '../../shared/ipc'
import { exportAccount, type ExportDeps } from './export-account'

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Spúšťa a sleduje zálohy. Zapisovať smie len do ciest, ktoré používateľ vybral v natívnom dialógu
 * (main proces ich oznámi cez `allow`), nie do ľubovoľnej cesty z rozhrania.
 */
export class ExportManager {
  private allowed = new Set<string>()
  private running = new Map<number, { controller: AbortController; accountId: number; progress: ExportProgress | null; promise: Promise<ExportSummary> }>()
  private last: ExportSummary | null = null

  constructor(
    private readonly deps: ExportDeps & { emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void },
    private readonly testHooks: { afterSnapshot?: () => Promise<void> } = {}
  ) {
    this.recoverInterrupted()
  }

  allow(path: string): void {
    if (typeof path === 'string' && /\.mbox$/i.test(path)) this.allowed.add(path)
  }

  isAllowed(path: string): boolean {
    return this.allowed.has(path)
  }

  /** Záloha prerušená pádom aplikácie: rozpracovaný súbor zmazať, úlohu označiť ako zlyhanú. */
  private recoverInterrupted(): void {
    const rows = this.deps.db.prepare(`SELECT id, progress_json FROM jobs WHERE kind = 'export' AND state = 'running'`).all() as { id: number; progress_json: string }[]
    for (const r of rows) {
      try {
        const part = (JSON.parse(r.progress_json) as { partPath?: string }).partPath
        if (part && part.endsWith('.mbox.part') && existsSync(part)) unlinkSync(part)
      } catch {
        /* ignorovať */
      }
      this.deps.db
        .prepare(`UPDATE jobs SET state = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), summary_json = ? WHERE id = ?`)
        .run(JSON.stringify({ result: 'failed', errorCode: 'INTERRUPTED' }), r.id)
    }
  }

  start(accountId: number, path: string): { jobId: number } {
    if (!Number.isInteger(accountId)) throw err('INVALID', 'Neplatné konto')
    if (!this.allowed.has(path)) throw err('PATH_NOT_ALLOWED', 'Súbor zálohy treba vybrať v dialógu')
    if ([...this.running.values()].some((r) => r.accountId === accountId)) throw err('EXPORT_RUNNING', 'Záloha tohto konta už prebieha')
    const acc = this.deps.db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId)
    if (!acc) throw err('NO_ACCOUNT', 'Konto neexistuje')

    const jobId = (this.deps.db
      .prepare(`INSERT INTO jobs (kind, account_id, state, started_at, progress_json) VALUES ('export', ?, 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?) RETURNING id`)
      .get(accountId, JSON.stringify({ partPath: `${path}.part` })) as { id: number }).id
    const controller = new AbortController()
    const entry = { controller, accountId, progress: null as ExportProgress | null, promise: Promise.resolve(null as unknown as ExportSummary) }
    entry.promise = exportAccount(this.deps, {
      jobId,
      accountId,
      path,
      signal: controller.signal,
      afterSnapshot: this.testHooks.afterSnapshot,
      onProgress: (p) => {
        entry.progress = p
        this.deps.emit('export.progress', p)
      }
    }).then((summary) => {
      this.running.delete(jobId)
      this.last = summary
      this.deps.db
        .prepare(`UPDATE jobs SET state = ?, finished_at = ?, summary_json = ? WHERE id = ?`)
        .run(summary.result === 'complete' ? 'done' : summary.result, summary.finishedAt, JSON.stringify(summary), jobId)
      this.deps.emit('export.finished', summary)
      return summary
    })
    this.running.set(jobId, entry)
    return { jobId }
  }

  cancel(jobId: number): void {
    this.running.get(jobId)?.controller.abort()
  }

  /** Pre testy: počká na dokončenie úlohy. */
  wait(jobId: number): Promise<ExportSummary> | undefined {
    return this.running.get(jobId)?.promise
  }

  state(): ExportState {
    const r = [...this.running.values()][0]
    return { running: r?.progress ?? null, last: this.last }
  }

  async cancelAll(): Promise<void> {
    const list = [...this.running.values()]
    for (const r of list) r.controller.abort()
    await Promise.allSettled(list.map((r) => r.promise))
  }
}
