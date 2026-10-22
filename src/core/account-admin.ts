import type { CoreContext } from './handlers'
import { getAccount, saveServerSettings, storedPassword, validateSettings } from './accounts'
import { passwordKey } from './secrets'
import { testConnection } from './mail/connection-test'
import type { ConnectionTestResult, ServerSettings } from '../shared/ipc'
import { logger } from './log'

const log = logger('accounts')

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Nové nastavenia servera: najprv sa overia (s novým alebo uloženým heslom), uložia sa len ak fungujú.
 * Synchronizácia konta potom začne odznova.
 */
export async function updateServer(
  ctx: CoreContext,
  id: number,
  input: { username?: unknown; imap?: ServerSettings; smtp?: ServerSettings; password?: unknown },
  test: typeof testConnection = testConnection
): Promise<{ saved: boolean; test: ConnectionTestResult }> {
  const acc = getAccount(ctx.db, id)
  const settings = validateSettings({
    email: acc.email,
    displayName: acc.displayName,
    username: typeof input?.username === 'string' ? input.username : acc.username,
    imap: input?.imap,
    smtp: input?.smtp,
    saveSentCopy: acc.saveSentCopy,
    providerKey: null
  })
  const newPassword = typeof input?.password === 'string' && input.password ? input.password.slice(0, 4096) : undefined
  const password = newPassword ?? (await storedPassword(ctx.db, ctx.secrets, ctx.sessionSecrets, id))
  if (!password) throw err('PASSWORD_REQUIRED', 'Zadajte heslo')
  const result = await test(settings, password)
  if (!result.imap.ok || !result.smtp.ok) return { saved: false, test: result }
  await saveServerSettings(ctx.db, ctx.secrets, ctx.sessionSecrets, id, settings, newPassword)
  await ctx.sync.restart(id)
  ctx.emit('accounts.changed', null)
  return { saved: true, test: result }
}

/**
 * Odstráni konto z Doaru: zastaví synchronizáciu, zmaže heslo a lokálnu kópiu (správy, priečinky, koncepty,
 * neodoslané správy). Na serveri sa nič nemení. Originály, na ktoré už nič neodkazuje, sa zmažú na pozadí.
 */
export async function removeAccount(ctx: CoreContext, id: number): Promise<void> {
  getAccount(ctx.db, id) // NOT_FOUND
  if (ctx.exports.state().running?.accountId === id) throw err('EXPORT_RUNNING', 'Záloha tohto konta práve prebieha')
  await ctx.sync.stop(id)
  await ctx.secrets.delete(passwordKey(id)).catch(() => {})
  await ctx.sessionSecrets.delete(passwordKey(id)).catch(() => {})
  ctx.db.prepare('DELETE FROM accounts WHERE id = ?').run(id) // priečinky, správy, fronta, koncepty: ON DELETE CASCADE
  ctx.db.prepare('DELETE FROM jobs WHERE account_id = ?').run(id)
  ctx.emit('accounts.changed', null)
  ctx.emit('folders.changed', { accountId: id })
  ctx.emit('outbox.changed', null)
  setTimeout(() => collectBlobs(ctx, 60_000), 0)
}

/** Upratanie úložiska originálov. `minAgeMs` chráni práve zapisované súbory. */
export function collectBlobs(ctx: Pick<CoreContext, 'store' | 'blobs'>, minAgeMs = 10 * 60_000): number {
  try {
    const removed = ctx.blobs.collectGarbage(ctx.store.referencedBlobs(), minAgeMs)
    if (removed) log.info('upratané nepoužívané originály', { removed })
    return removed
  } catch (e) {
    log.warn('upratanie úložiska zlyhalo', { error: e })
    return 0
  }
}
