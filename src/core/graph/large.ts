/**
 * Veľké správy cez Microsoft Graph. Správa v MIME sa dá poslať len do ~4 MB (limit jednej požiadavky),
 * väčšia sa preto poskladá po častiach ako v Outlooku:
 *   1. koncept v JSON (predmet, telo, príjemcovia, Message-ID),
 *   2. prílohy: malé priamo, veľké cez „upload session“ po kúskoch (do 150 MB na prílohu),
 *   3. pri odoslaní POST /send (koncept sa presunie do Odoslaných).
 *
 * Obmedzenie: Graph nedovolí nastaviť hlavičky In-Reply-To/References (len X-…), takže pri veľkej odpovedi
 * ju niektoré programy príjemcu nemusia zaradiť do vlákna. Predmet a citácia zostanú.
 */
import { simpleParser, type AddressObject, type Attachment } from 'mailparser'
import { logger } from '../log'
import type { GraphClient, GraphError } from './client'

const log = logger('graph')

/** Príloha do tejto veľkosti ide priamo (base64 sa vojde do jednej požiadavky), väčšia po kúskoch. */
const DIRECT_MAX = 2 * 1024 * 1024
/** Kúsok pri nahrávaní: násobok 320 KiB (požiadavka Graph), menej než 4 MB. */
export const CHUNK = 10 * 320 * 1024
/** Najväčšia príloha, ktorú Graph prijme. */
export const MAX_ATTACHMENT = 150 * 1024 * 1024

type Recipient = { emailAddress: { name?: string; address: string } }

function recipients(a: AddressObject | AddressObject[] | undefined): Recipient[] {
  const list = Array.isArray(a) ? a : a ? [a] : []
  return list
    .flatMap((x) => x.value)
    .filter((v) => v.address)
    .map((v) => ({ emailAddress: { ...(v.name ? { name: v.name } : {}), address: v.address! } }))
}

function gerr(code: string, message: string, extra: Partial<GraphError> = {}): GraphError {
  return Object.assign(new Error(message), { code, ...extra }) as GraphError
}

/** Chyba pred samotným odoslaním: správa určite neodišla (fronta ju skúsi znova, nie „nejasné“). */
function notSent(e: unknown): GraphError {
  const g = e as GraphError
  return Object.assign(g, { uncertain: false })
}

/**
 * Vytvorí v schránke koncept z celej správy (MIME) aj s prílohami a vráti jeho ID.
 * Ak niečo zlyhá, rozpracovaný koncept sa zmaže.
 */
export async function createLargeDraft(graph: GraphClient, raw: Buffer): Promise<string> {
  const p = await simpleParser(raw, { keepCidLinks: true, skipHtmlToText: true, skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true })
  const big = p.attachments.find((a) => a.size > MAX_ATTACHMENT || a.content.length > MAX_ATTACHMENT)
  if (big) throw gerr('GRAPH_TOO_LARGE', 'Príloha je väčšia než 150 MB')
  const html = typeof p.html === 'string' && p.html ? p.html : null
  const message: Record<string, unknown> = {
    subject: p.subject ?? '',
    body: html ? { contentType: 'html', content: html } : { contentType: 'text', content: p.text ?? '' },
    toRecipients: recipients(p.to),
    ccRecipients: recipients(p.cc),
    bccRecipients: recipients(p.bcc),
    replyTo: recipients(p.replyTo)
  }
  if (p.messageId) message['internetMessageId'] = p.messageId
  let id: string
  try {
    id = ((await graph.request('POST', '/me/messages', { json: message })).json as { id: string }).id
  } catch (e) {
    throw notSent(e)
  }
  try {
    for (const a of p.attachments) await addAttachment(graph, id, a)
  } catch (e) {
    log.warn('prílohu sa nepodarilo nahrať – koncept sa zmaže', { code: (e as GraphError).code })
    await graph.request('DELETE', `/me/messages/${encodeURIComponent(id)}`).catch(() => {})
    throw notSent(e)
  }
  return id
}

async function addAttachment(graph: GraphClient, messageId: string, a: Attachment): Promise<void> {
  const name = a.filename || (a.contentType.startsWith('image/') ? 'obrazok' : 'priloha')
  const inline = !!a.cid && (a.contentDisposition === 'inline' || a.related)
  const meta = { name, contentType: a.contentType, isInline: inline, ...(inline ? { contentId: a.cid } : {}) }
  const base = `/me/messages/${encodeURIComponent(messageId)}/attachments`
  if (a.content.length <= DIRECT_MAX) {
    await graph.request('POST', base, { json: { '@odata.type': '#microsoft.graph.fileAttachment', ...meta, contentBytes: a.content.toString('base64') } })
    return
  }
  const session = (await graph.request('POST', `${base}/createUploadSession`, { json: { AttachmentItem: { attachmentType: 'file', size: a.content.length, ...meta } } })).json as { uploadUrl?: string }
  if (!session.uploadUrl) throw gerr('PROTOCOL', 'Server nevrátil adresu na nahranie prílohy')
  for (let start = 0; start < a.content.length; start += CHUNK) {
    const chunk = a.content.subarray(start, Math.min(start + CHUNK, a.content.length))
    await graph.uploadChunk(session.uploadUrl, chunk, start, a.content.length)
  }
}

/** Odošle veľkú správu: koncept s prílohami, potom /send. Chyba pri /send môže byť „nejasná“ (uncertain). */
export async function sendLarge(graph: GraphClient, raw: Buffer): Promise<void> {
  const id = await createLargeDraft(graph, raw)
  try {
    await graph.request('POST', `/me/messages/${encodeURIComponent(id)}/send`)
  } catch (e) {
    // Určite neodišla → koncept preč (fronta ho pri ďalšom pokuse vytvorí znova). Nejasné → nechať, nech je vidieť.
    if (!(e as GraphError).uncertain && (e as GraphError).code !== 'TIMEOUT') await graph.request('DELETE', `/me/messages/${encodeURIComponent(id)}`).catch(() => {})
    throw e
  }
}
