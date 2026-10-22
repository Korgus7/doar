import type { BlobStore } from './store/blobs'
import type { DraftRow, MailStore } from './store/mailstore'
import type { Address, ComposeAttachment, ComposePrefill, DraftSaveInput } from '../shared/ipc'
import { composeMessage, newMessageId, parseAddressList, replySource } from './mail/compose'
import { extractAttachments } from './mail/parse'
import { htmlToText, outgoingHtml, sanitizeComposeHtml } from './mail/outgoing-html'
import { account, originalRaw, resolveAttachments, type Ctx } from './compose-service'

/**
 * Koncepty. Okno správy ukladá rozpísaný text priebežne do lokálnej databázy (nič sa nestratí ani pri páde);
 * na server do priečinka Koncepty sa nahrá s odstupom (`SyncManager.draftDelayMs`, 30 s) alebo hneď pri zatvorení okna.
 * Nová verzia na serveri nahradí predošlú – nájde sa podľa stabilného Message-ID.
 */

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export interface DraftData {
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  /** Formátovaný text (prečistené HTML z editora), alebo null pri čistom texte. */
  html?: string | null
  replyToMessage: number | null
}

export interface DraftAttachment {
  name: string
  sha: string
  size: number
  contentType?: string
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

function schedulePush(ctx: Ctx, draftId: number, accountId: number, now: boolean): void {
  const payload = { draftId }
  if (!ctx.store.hasPendingOperation(accountId, 'draft', payload)) {
    ctx.store.enqueueOperation(accountId, 'draft', payload, now ? undefined : new Date(Date.now() + ctx.sync.draftDelayMs))
  } else if (now) ctx.store.expediteOperation(accountId, 'draft', payload)
  const s = ctx.sync.get(accountId)
  if (now) void s?.pushOperations().catch(() => {})
  else s?.scheduleDelayedOperations()
}

export async function saveDraft(ctx: Ctx, input: DraftSaveInput): Promise<{ draftId: number; attachments: ComposeAttachment[] }> {
  const acc = account(ctx.db, Number(input?.accountId))
  if (!acc) throw err('NO_ACCOUNT', 'Konto neexistuje')
  const data: DraftData = {
    to: str(input.to, 20_000),
    cc: str(input.cc, 20_000),
    bcc: str(input.bcc, 20_000),
    subject: str(input.subject, 1000),
    text: str(input.text, 5_000_000),
    html: typeof input.html === 'string' && input.html.trim() ? sanitizeComposeHtml(input.html) : null,
    replyToMessage: Number.isInteger(input.replyToMessage) ? (input.replyToMessage as number) : null
  }
  if (data.html) data.text = htmlToText(data.html)
  const resolved = await resolveAttachments(ctx, input.attachments ?? [])
  const atts: DraftAttachment[] = resolved.map((a) => ({ name: a.filename, sha: ctx.blobs.put(a.content), size: a.content.length, contentType: a.contentType }))

  let row = Number.isInteger(input.draftId) ? ctx.store.draft(input.draftId as number) : null
  if (row?.deleted) row = null // medzitým odoslaný alebo zahodený v inom okne → nový koncept
  let id: number
  if (!row) {
    id = ctx.store.insertDraft({ accountId: acc.id, messageId: newMessageId(acc.email), data, attachments: atts })
  } else {
    id = row.id
    if (row.account_id !== acc.id && row.server_folder_id) {
      // Iné konto odosielateľa: kópiu v Konceptoch pôvodného konta treba odstrániť.
      ctx.store.enqueueOperation(row.account_id, 'draftRemove', { folderId: row.server_folder_id, messageId: row.message_id, uid: row.server_uid })
      void ctx.sync.get(row.account_id)?.pushOperations().catch(() => {})
      ctx.store.setDraftServer(id, null, null)
    }
    ctx.store.updateDraft(id, { accountId: acc.id, data, attachments: atts })
  }
  schedulePush(ctx, id, acc.id, !!input.flush)
  return { draftId: id, attachments: atts.map((a) => ({ kind: 'blob', sha: a.sha, name: a.name, contentType: a.contentType })) }
}

/** Zatvorenie okna: posledná uložená verzia ide na server hneď. */
export function flushDraft(ctx: Ctx, draftId: number): void {
  const row = ctx.store.draft(draftId)
  if (!row || row.deleted || row.server_rev >= row.rev) return
  schedulePush(ctx, row.id, row.account_id, true)
}

/** Zahodenie (alebo odoslanie) konceptu: zmizne zo zoznamu hneď, zo servera pri najbližšej synchronizácii. */
export function discardDraft(ctx: Ctx, draftId: number): void {
  const row = ctx.store.draft(draftId)
  if (!row || row.deleted) return
  ctx.store.markDraftDeleted(row.id)
  if (row.server_folder_id && row.server_uid) {
    const m = ctx.store.messageByUid(row.server_folder_id, row.server_uid)
    if (m) {
      ctx.store.setHidden([m], true)
      ctx.emit('messages.changed', { folderIds: [row.server_folder_id] })
    }
  }
  ctx.store.enqueueOperation(row.account_id, 'draftDelete', { draftId: row.id })
  void ctx.sync.get(row.account_id)?.pushOperations().catch(() => {})
}

function addressLine(list: Address[]): string {
  return list.map((a) => (a.name ? `${a.name.replace(/[",<>]/g, '')} <${a.address}>` : a.address)).join(', ')
}

function prefillFromRow(row: DraftRow): ComposePrefill {
  const d = JSON.parse(row.data_json) as DraftData
  const atts = JSON.parse(row.attachments_json) as DraftAttachment[]
  return {
    accountId: row.account_id,
    to: parseAddressList(d.to).valid,
    cc: parseAddressList(d.cc).valid,
    subject: d.subject,
    draft: { to: d.to, cc: d.cc, bcc: d.bcc, text: d.text, html: d.html ?? null },
    quote: null,
    forward: null,
    attachments: atts.map((a) => ({ source: { kind: 'blob' as const, sha: a.sha, name: a.name, contentType: a.contentType }, filename: a.name, size: a.size })),
    replyToMessage: d.replyToMessage,
    draftId: row.id
  }
}

/**
 * Otvorenie konceptu z priečinka Koncepty. Ak ho upravoval Doar, použije sa lokálna (najnovšia) verzia;
 * koncept z iného programu sa načíta zo servera a odteraz sa ukladá ako náš.
 */
export async function prepareDraft(ctx: Ctx, messageId: number): Promise<ComposePrefill> {
  const m = ctx.store.message(messageId)
  if (!m) throw err('NOT_FOUND', 'Správa neexistuje')
  const local = m.message_id ? ctx.store.draftByMessageId(m.message_id) : null
  if (local && local.account_id === m.account_id) return prefillFromRow(local)

  const { raw } = await originalRaw(ctx, messageId)
  const src = await replySource(raw)
  const atts: DraftAttachment[] = (await extractAttachments(raw)).map((a) => ({
    name: a.filename,
    sha: ctx.blobs.put(a.content),
    size: a.content.length,
    contentType: a.contentType
  }))
  const acc = account(ctx.db, m.account_id)
  const replyTo = src.inReplyTo ? ctx.store.messageByMessageId(m.account_id, src.inReplyTo) : null
  const data: DraftData = {
    to: addressLine(src.to),
    cc: addressLine(src.cc),
    bcc: addressLine(src.bcc),
    subject: src.subject,
    text: src.text,
    html: src.html ? sanitizeComposeHtml(src.html) || null : null,
    replyToMessage: replyTo
  }
  const id = ctx.store.insertDraft({
    accountId: m.account_id,
    messageId: m.message_id || newMessageId(acc?.email ?? 'doar.local'),
    data,
    attachments: atts,
    serverFolderId: m.folder_id,
    serverUid: m.uid,
    synced: true
  })
  return prefillFromRow(ctx.store.draft(id)!)
}

/** MIME podoba konceptu na nahratie do Konceptov na serveri. */
export async function buildDraftRaw(store: MailStore, blobs: BlobStore, row: DraftRow, from: Address): Promise<Buffer> {
  const d = JSON.parse(row.data_json) as DraftData
  const atts = JSON.parse(row.attachments_json) as DraftAttachment[]
  const original = d.replyToMessage ? store.message(d.replyToMessage) : null
  const { raw } = await composeMessage({
    from,
    to: parseAddressList(d.to).valid,
    cc: parseAddressList(d.cc).valid,
    bcc: parseAddressList(d.bcc).valid,
    subject: d.subject,
    text: d.html ? htmlToText(d.html) : d.text,
    html: d.html ? outgoingHtml(d.html) : null,
    messageId: row.message_id,
    inReplyTo: original?.message_id ?? null,
    references: original?.message_id ? [original.message_id] : [],
    attachments: atts.filter((a) => blobs.has(a.sha)).map((a) => ({ filename: a.name, content: blobs.read(a.sha), contentType: a.contentType }))
  })
  return raw
}
