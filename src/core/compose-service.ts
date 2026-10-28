import type { Db } from './store/db'
import type { BlobStore } from './store/blobs'
import type { MailStore } from './store/mailstore'
import type { SyncManager } from './sync/manager'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { Address, ComposeMode, ComposePrefill, ComposeSendInput, CoreEvents, EventChannel } from '../shared/ipc'
import { MAX_ATTACHMENTS_BYTES, isArchiveId } from '../shared/ipc'
import type { ArchiveManager } from './archive/archive'
import { composeMessage, forwardSubject, parseAddressList, replySource, replySubject } from './mail/compose'
import { extractAttachments } from './mail/parse'
import { htmlToText, inlineImages, outgoingHtml } from './mail/outgoing-html'
import type { FileGrants } from './files'
import { discardDraft, draftFromRaw, prepareDraft } from './drafts'

function err(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra })
}

export interface Ctx {
  db: Db
  blobs: BlobStore
  store: MailStore
  sync: SyncManager
  /** Súbory povolené používateľom (prílohy z disku). */
  files?: FileGrants
  /** Lokálne archívy (odpoveď alebo preposlanie správy z archívu). */
  archives?: ArchiveManager
  emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
}

interface AccountInfo {
  id: number
  email: string
  display_name: string
  save_sent_copy: number
}

export function account(db: Db, id: number): AccountInfo | null {
  return (db.prepare('SELECT id, email, display_name, save_sent_copy FROM accounts WHERE id = ?').get(id) as unknown as AccountInfo | undefined) ?? null
}

export async function originalRaw(ctx: Ctx, messageId: number): Promise<{ raw: Buffer; accountId: number; internalDate: string | null }> {
  if (isArchiveId(messageId)) {
    // Správa z archívu: odpovedá sa z konta, z ktorého záloha pochádza (ak je v Doare), inak z prvého konta.
    if (!ctx.archives) throw err('NOT_FOUND', 'Správa neexistuje')
    const meta = ctx.archives.meta(messageId)
    const acc = (meta.source ? (ctx.db.prepare('SELECT id FROM accounts WHERE lower(email) = lower(?)').get(meta.source) as { id: number } | undefined) : undefined) ??
      (ctx.db.prepare('SELECT id FROM accounts ORDER BY sort_order, id LIMIT 1').get() as { id: number } | undefined)
    if (!acc) throw err('NO_ACCOUNT', 'Najprv pridajte konto')
    return { raw: await ctx.archives.raw(messageId), accountId: acc.id, internalDate: meta.date }
  }
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
    return { accountId: first.id, to: [], cc: [], subject: '', draft: null, quote: null, forward: null, attachments: [], replyToMessage: null, draftId: null }
  }
  if (mode === 'draft') return prepareDraft(ctx, messageId)
  const { raw, accountId, internalDate } = await originalRaw(ctx, messageId)
  const src = await replySource(raw)
  if (mode === 'forward') {
    const atts = await extractAttachments(raw)
    return {
      accountId,
      to: [],
      cc: [],
      subject: forwardSubject(src.subject),
      draft: null,
      quote: null,
      forward: { from: src.from, to: src.to, cc: src.cc, date: src.date ?? internalDate, subject: src.subject, text: src.text },
      attachments: atts.map((a, index) => ({ source: { kind: 'message' as const, messageId, index }, filename: a.filename, size: a.content.length })),
      replyToMessage: null,
      draftId: null
    }
  }
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
    draft: null,
    subject: replySubject(src.subject),
    // Bez hlavičky Date použijeme dátum prijatia zo servera.
    quote: { from: src.from, date: src.date ?? internalDate, text: src.text },
    forward: null,
    attachments: [],
    replyToMessage: messageId,
    draftId: null
  }
}

/** Zloží správu a zaradí ju do odosielacej fronty. Odoslanie prebehne hneď, ak je spojenie. */
export async function sendCompose(ctx: Ctx, input: ComposeSendInput, opts: { remember?: boolean } = {}): Promise<{ outboxId: number }> {
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

  // Odoslať neskôr: čas v budúcnosti (najviac o rok). Čas v minulosti = odoslať hneď.
  let sendAt: Date | null = null
  if (typeof input.sendAt === 'string' && input.sendAt) {
    const t = Date.parse(input.sendAt)
    if (!Number.isFinite(t) || t > Date.now() + 366 * 86_400_000) throw err('INVALID_SEND_AT', 'Neplatný čas odoslania')
    if (t > Date.now() + 30_000) sendAt = new Date(t)
  }

  const attachments = await resolveAttachments(ctx, input.attachments)
  // Formátovaná správa: HTML sa prečistí, textová alternatíva vznikne z neho (nie z rozhrania).
  const html = typeof input.html === 'string' && input.html.trim() ? input.html : null
  // Adresáti sa zapamätajú pre našepkávanie a adresár (nie pri odhlásení z odberu).
  if (opts.remember !== false) ctx.store.rememberNames(recipients)

  // Logo v podpise a iné vložené obrázky → prílohy s Content-ID.
  const inlined = html ? inlineImages(outgoingHtml(html), acc.email.split('@')[1]) : null
  const { raw, messageId } = await composeMessage({
    from: { name: acc.display_name, address: acc.email },
    to: to.valid,
    cc: cc.valid,
    bcc: bcc.valid,
    subject: str(input.subject, 1000),
    text: html ? htmlToText(html) : str(input.text, 5_000_000),
    html: inlined?.html ?? null,
    inReplyTo,
    references,
    attachments: [...attachments, ...(inlined?.images ?? [])],
    ...(sendAt ? { date: sendAt } : {})
  })
  const sha = ctx.blobs.put(raw)
  const outboxId = ctx.store.addOutbox({
    accountId: acc.id,
    sha,
    messageId,
    subject: str(input.subject, 1000),
    recipients: recipients.map((a) => a.address),
    replyTo,
    saveCopy: acc.save_sent_copy === 1,
    sendAt: sendAt?.toISOString() ?? null
  })
  ctx.emit('outbox.changed', null)
  ctx.sync.get(acc.id)?.refreshStatus()
  void ctx.sync.get(acc.id)?.processOutboxNow().catch(() => {})
  // Odoslaný koncept už nie je koncept – zmaže sa lokálne aj na serveri.
  if (Number.isInteger(input.draftId)) discardDraft(ctx, input.draftId as number)
  return { outboxId }
}

/** Načíta prílohy: súbory povolené cez dialóg/pretiahnutie a prílohy preposielanej správy. */
export async function resolveAttachments(ctx: Ctx, list: unknown): Promise<{ filename: string; content: Buffer; contentType?: string }[]> {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list) || list.length > 100) throw err('INVALID', 'Neplatné prílohy')
  const out: { filename: string; content: Buffer; contentType?: string }[] = []
  const fromMessage = new Map<number, Awaited<ReturnType<typeof extractAttachments>>>()
  let total = 0
  const add = (a: { filename: string; content: Buffer; contentType?: string }): void => {
    total += a.content.length
    if (total > MAX_ATTACHMENTS_BYTES) throw err('ATTACHMENTS_TOO_LARGE', 'Prílohy sú príliš veľké')
    out.push(a)
  }
  for (const item of list as { kind?: unknown; path?: unknown; messageId?: unknown; index?: unknown }[]) {
    if (item?.kind === 'file' && typeof item.path === 'string') {
      if (!ctx.files) throw err('PATH_NOT_ALLOWED', 'Súbor treba vybrať v dialógu')
      const path = await ctx.files.require(item.path, 'read')
      let size: number
      try {
        const st = statSync(path)
        if (!st.isFile()) throw new Error('nie je súbor')
        size = st.size
      } catch {
        throw Object.assign(err('ATTACHMENT_MISSING', `Súbor nenájdený: ${basename(path)}`), { name: basename(path) })
      }
      if (total + size > MAX_ATTACHMENTS_BYTES) throw err('ATTACHMENTS_TOO_LARGE', 'Prílohy sú príliš veľké')
      add({ filename: basename(path), content: readFileSync(path) })
    } else if (item?.kind === 'message' && Number.isInteger(item.messageId) && Number.isInteger(item.index)) {
      const id = item.messageId as number
      if (!fromMessage.has(id)) fromMessage.set(id, await extractAttachments((await originalRaw(ctx, id)).raw))
      const a = fromMessage.get(id)![item.index as number]
      if (!a) throw err('NOT_FOUND', 'Príloha pôvodnej správy neexistuje')
      add({ filename: a.filename, content: a.content, contentType: a.contentType })
    } else if (item?.kind === 'blob' && typeof (item as { sha?: unknown }).sha === 'string') {
      const b = item as { sha: string; name?: unknown; contentType?: unknown }
      // Len prílohy uložené v konceptoch – nie ľubovoľný obsah lokálneho úložiska.
      if (!ctx.store.isDraftBlob(b.sha) || !ctx.blobs.has(b.sha)) throw err('NOT_FOUND', 'Príloha konceptu neexistuje')
      add({
        filename: typeof b.name === 'string' && b.name ? b.name.slice(0, 255) : 'priloha',
        content: ctx.blobs.read(b.sha),
        contentType: typeof b.contentType === 'string' ? b.contentType.slice(0, 200) : undefined
      })
    } else throw err('INVALID', 'Neplatná príloha')
  }
  return out
}

/** Rozhodnutie používateľa pri chybe alebo nejasnom výsledku: znova odoslať, alebo zahodiť. */
/** Naplánovaná správa: odoslať hneď, alebo zrušiť – vráti sa medzi koncepty (s prílohami), dá sa upraviť. */
export async function scheduledOutbox(ctx: Ctx, id: number, action: 'sendNow' | 'cancel'): Promise<{ draftId: number | null }> {
  const row = ctx.store.outboxRow(id)
  if (!row) throw err('NOT_FOUND', 'Položka neexistuje')
  if (row.state !== 'queued' || !row.send_at) throw err('INVALID_STATE', 'Správa sa práve odosiela alebo už bola odoslaná')
  if (action === 'sendNow') {
    ctx.store.setOutboxSendAt(id, null)
    ctx.emit('outbox.changed', null)
    ctx.sync.get(row.account_id)?.refreshStatus()
    void ctx.sync.get(row.account_id)?.processOutboxNow().catch(() => {})
    return { draftId: null }
  }
  const draftId = await draftFromRaw(ctx, row.account_id, ctx.blobs.read(row.blob_sha256), row.reply_to_message)
  ctx.store.deleteOutbox(id)
  ctx.emit('outbox.changed', null)
  ctx.sync.get(row.account_id)?.refreshStatus()
  void ctx.sync.get(row.account_id)?.processOutboxNow().catch(() => {})
  return { draftId }
}

export function resolveOutbox(ctx: Ctx, id: number, action: 'resend' | 'discard'): void {
  const row = ctx.store.outboxRow(id)
  if (!row) throw err('NOT_FOUND', 'Položka neexistuje')
  // Čakajúcu na pripojenie (nič neodišlo) možno tiež zrušiť.
  const waiting = row.state === 'queued' && row.error === 'OFFLINE'
  if (row.state !== 'error' && row.state !== 'uncertain' && !waiting) throw err('INVALID_STATE', 'Správa sa práve odosiela alebo už bola odoslaná')
  if (action === 'discard') ctx.store.deleteOutbox(id)
  else {
    ctx.store.setOutbox(id, { state: 'queued', error: null })
    void ctx.sync.get(row.account_id)?.processOutboxNow().catch(() => {})
  }
  ctx.emit('outbox.changed', null)
}
