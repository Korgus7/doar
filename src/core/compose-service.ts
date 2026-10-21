import type { Db } from './store/db'
import type { BlobStore } from './store/blobs'
import type { MailStore } from './store/mailstore'
import type { SyncManager } from './sync/manager'
import type { Address, ComposeMode, ComposePrefill, ComposeSendInput, CoreEvents, EventChannel } from '../shared/ipc'
import { composeMessage, parseAddressList, replySource, replySubject } from './mail/compose'

function err(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra })
}

interface Ctx {
  db: Db
  blobs: BlobStore
  store: MailStore
  sync: SyncManager
  emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
}

interface AccountInfo {
  id: number
  email: string
  display_name: string
  save_sent_copy: number
}

function account(db: Db, id: number): AccountInfo | null {
  return (db.prepare('SELECT id, email, display_name, save_sent_copy FROM accounts WHERE id = ?').get(id) as unknown as AccountInfo | undefined) ?? null
}

async function originalRaw(ctx: Ctx, messageId: number): Promise<{ raw: Buffer; accountId: number; internalDate: string | null }> {
  let row = ctx.store.message(messageId)
  if (!row) throw err('NOT_FOUND', 'Správa neexistuje')
  if (!row.blob_sha256) {
    await ctx.sync.get(row.account_id)?.fetchBodyNow(messageId)
    row = ctx.store.message(messageId)
    if (!row?.blob_sha256) throw err('BODY_UNAVAILABLE', 'Pôvodná správa nie je stiahnutá')
  }
  return { raw: ctx.blobs.read(row.blob_sha256), accountId: row.account_id, internalDate: row.internal_date }
}

/** Predvyplnenie okna správy. Pri odpovedi sa použije konto, na ktoré správa prišla. */
export async function prepareCompose(ctx: Ctx, mode: ComposeMode, messageId?: number): Promise<ComposePrefill> {
  if (mode === 'new' || !messageId) {
    const first = ctx.db.prepare('SELECT id FROM accounts ORDER BY sort_order, id LIMIT 1').get() as { id: number } | undefined
    if (!first) throw err('NO_ACCOUNT', 'Najprv pridajte konto')
    return { accountId: first.id, to: [], cc: [], subject: '', quote: null, replyToMessage: null }
  }
  const { raw, accountId, internalDate } = await originalRaw(ctx, messageId)
  const src = await replySource(raw)
  const own = new Set((ctx.db.prepare('SELECT lower(email) AS e FROM accounts').all() as { e: string }[]).map((r) => r.e))
  const to = (src.replyTo.length ? src.replyTo : src.from).filter((a) => !own.has(a.address.toLowerCase()))
  // Odpoveď na vlastnú odoslanú správu → pôvodným adresátom.
  const toFinal = to.length ? to : src.to
  let cc: Address[] = []
  if (mode === 'replyAll') {
    const seen = new Set(toFinal.map((a) => a.address.toLowerCase()))
    for (const a of [...src.to, ...src.cc]) {
      const k = a.address.toLowerCase()
      if (own.has(k) || seen.has(k)) continue
      seen.add(k)
      cc.push(a)
    }
  }
  return {
    accountId,
    to: toFinal,
    cc,
    subject: replySubject(src.subject),
    // Bez hlavičky Date použijeme dátum prijatia zo servera.
    quote: { from: src.from, date: src.date ?? internalDate, text: src.text },
    replyToMessage: messageId
  }
}

/** Zloží správu a zaradí ju do odosielacej fronty. Odoslanie prebehne hneď, ak je spojenie. */
export async function sendCompose(ctx: Ctx, input: ComposeSendInput): Promise<{ outboxId: number }> {
  const acc = account(ctx.db, Number(input?.accountId))
  if (!acc) throw err('NO_ACCOUNT', 'Konto neexistuje')
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const to = parseAddressList(str(input.to, 20_000))
  const cc = parseAddressList(str(input.cc, 20_000))
  const bcc = parseAddressList(str(input.bcc, 20_000))
  const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid]
  if (invalid.length) throw err('INVALID_RECIPIENTS', `Neplatné adresy: ${invalid.join(', ')}`, { invalid })
  const recipients = [...to.valid, ...cc.valid, ...bcc.valid]
  if (!recipients.length) throw err('NO_RECIPIENTS', 'Zadajte aspoň jedného adresáta')
  if (recipients.length > 500) throw err('TOO_MANY_RECIPIENTS', 'Príliš veľa adresátov')

  let inReplyTo: string | null = null
  let references: string[] = []
  const replyTo = Number.isInteger(input.replyToMessage) ? (input.replyToMessage as number) : null
  if (replyTo) {
    const { raw } = await originalRaw(ctx, replyTo)
    const src = await replySource(raw)
    inReplyTo = src.messageId
    references = [...src.references, ...(src.messageId ? [src.messageId] : [])].slice(-30)
  }

  const { raw, messageId } = await composeMessage({
    from: { name: acc.display_name, address: acc.email },
    to: to.valid,
    cc: cc.valid,
    bcc: bcc.valid,
    subject: str(input.subject, 1000),
    text: str(input.text, 5_000_000),
    inReplyTo,
    references
  })
  const sha = ctx.blobs.put(raw)
  const outboxId = ctx.store.addOutbox({
    accountId: acc.id,
    sha,
    messageId,
    subject: str(input.subject, 1000),
    recipients: recipients.map((a) => a.address),
    replyTo,
    saveCopy: acc.save_sent_copy === 1
  })
  ctx.emit('outbox.changed', null)
  void ctx.sync.get(acc.id)?.processOutboxNow().catch(() => {})
  return { outboxId }
}

/** Rozhodnutie používateľa pri chybe alebo nejasnom výsledku: znova odoslať, alebo zahodiť. */
export function resolveOutbox(ctx: Ctx, id: number, action: 'resend' | 'discard'): void {
  const row = ctx.store.outboxRow(id)
  if (!row) throw err('NOT_FOUND', 'Položka neexistuje')
  if (row.state !== 'error' && row.state !== 'uncertain') throw err('INVALID_STATE', 'Správa sa práve odosiela alebo už bola odoslaná')
  if (action === 'discard') ctx.store.deleteOutbox(id)
  else {
    ctx.store.setOutbox(id, { state: 'queued', error: null })
    void ctx.sync.get(row.account_id)?.processOutboxNow().catch(() => {})
  }
  ctx.emit('outbox.changed', null)
}
