import { mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '../store/db'
import type { BlobStore } from '../store/blobs'
import type { MailStore } from '../store/mailstore'
import { safeFilename } from '../files'
import { exportAccount } from './export-account'
import { logger } from '../log'

const log = logger('rescue')

/** Podpriečinok dátového priečinka Doaru so zachránenými súbormi. */
export const RESCUE_DIR = 'zachranene'

export interface RescueDeps {
  db: Db
  store: MailStore
  blobs: BlobStore
  /** Priečinok na zachránené súbory (v dátovom priečinku Doaru). */
  dir: string
}

export interface RescueResult {
  accountId: number
  email: string
  folderPath: string
  path: string
  /** Uložené správy (s obsahom). */
  written: number
  /** Správy bez stiahnutého obsahu – v súbore nie sú. */
  missing: number
}

/** Názov súboru: „Zachránené – konto – priečinok – dátum čas.mbox“. */
export function rescueFileName(email: string, folderPath: string, now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
  return safeFilename(`Zachránené – ${email} – ${folderPath} – ${stamp}.mbox`, 'Zachranene.mbox')
}

/**
 * Pred hromadným zmazaním (server stratil správy, schránka založená nanovo, zmiznutý priečinok): lokálne kópie
 * správ uloží do súboru mbox vo formáte zálohy Doar (docs/MBOX-METADATA.md) – bez pripojenia k serveru.
 * Súbor vzniká cez „.part“; ak niektorým správam chýba obsah, dostane v názve „-NEUPLNA“.
 * Vráti null, ak nebolo čo uložiť (žiadna správa nemá obsah). Pri chybe zápisu vyhodí výnimku.
 */
export async function rescueMessages(deps: RescueDeps, accountId: number, folderPath: string, messageIds: number[]): Promise<RescueResult | null> {
  if (!messageIds.length) return null
  const acc = deps.db.prepare('SELECT email FROM accounts WHERE id = ?').get(accountId) as { email: string } | undefined
  if (!acc) return null
  mkdirSync(deps.dir, { recursive: true })
  const path = join(deps.dir, rescueFileName(acc.email, folderPath))
  const summary = await exportAccount(
    {
      db: deps.db,
      store: deps.store,
      blobs: deps.blobs,
      newClient: () => Promise.reject(Object.assign(new Error('Záchrana pracuje bez servera'), { code: 'OFFLINE' }))
    },
    { jobId: 0, accountId, path, source: 'local', messageIds, signal: new AbortController().signal, onProgress: () => {} }
  )
  if (summary.result === 'failed' || summary.result === 'cancelled' || !summary.path) {
    throw Object.assign(new Error('Záchranu sa nepodarilo uložiť'), { code: summary.errorCode ?? 'WRITE_FAILED' })
  }
  const result: RescueResult = {
    accountId,
    email: acc.email,
    folderPath,
    path: summary.path,
    written: summary.totals.exported,
    missing: summary.totals.unavailable + summary.totals.failed
  }
  if (result.written === 0) {
    // Nič s obsahom – prázdny súbor nemá zmysel (správy mali len hlavičky, obsah sa nikdy nestiahol).
    await unlink(summary.path).catch(() => {})
    log.warn('záchrana: žiadna správa nemala stiahnutý obsah', { account: accountId, missing: result.missing })
    return null
  }
  log.info('lokálne kópie zachránené', { account: accountId, written: result.written, missing: result.missing })
  return result
}
