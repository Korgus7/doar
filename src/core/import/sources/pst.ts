import { createHash } from 'node:crypto'
import { PSTFile, type PSTFolder, type PSTMessage } from 'pst-extractor'
import MailComposer from 'nodemailer/lib/mail-composer'
import { yieldNow, type SourceInfo, type SourceMessage } from './common'

/**
 * Outlook (.pst, aj .ost): súbor sa číta knižnicou pst-extractor (MIT). Outlook neukladá správy ako text
 * RFC 5322, ale ako vlastnosti (MAPI). Správu preto znova zložíme: pôvodné internetové hlavičky
 * (ak ich Outlook uložil – prijatá pošta) + telo a prílohy. Hranice MIME sú odvodené z obsahu,
 * takže rovnaký súbor dá vždy rovnaké správy (opakovaný import nič nezdvojí).
 */

const MAX_ATTACHMENT = 100 * 1024 * 1024
const MAX_DEPTH = 20

// Triedy správ, ktoré sú e-maily (nie kalendár, kontakty, úlohy, poznámky).
const MAIL_CLASS = /^(IPM\.Note|IPM\.Schedule|IPM\.Post|REPORT\.IPM\.Note)/i
// Priečinky pošty (prázdna trieda = staršie súbory bez nej).
const MAIL_FOLDER = (cls: string): boolean => !cls || /^IPF\.(Note|Imap)/i.test(cls)

const PR_FLAG_STATUS = 0x1090
const VERB_REPLY = 102
const VERB_REPLY_ALL = 103
const VERB_FORWARD = 104

// Hlavičky, ktoré opisujú telo – nahradia ich hlavičky novo zloženej správy.
const BODY_HEADERS = /^(content-type|content-transfer-encoding|mime-version|content-disposition|content-id|content-length|content-description)$/i

export class NotPstError extends Error {
  readonly code = 'NOT_PST'
  constructor() {
    super('Súbor nie je súbor údajov Outlooku (.pst)')
  }
}

function openPst(path: string): PSTFile {
  try {
    return new PSTFile(path)
  } catch {
    throw new NotPstError()
  }
}

interface MailFolder {
  folder: PSTFolder
  path: string[]
}

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * Priečinky s poštou. Koreň a „Top of Personal Folders“ / „Začiatok súboru údajov“ (prázdny priečinok
 * na prvej úrovni s podpriečinkami) sa v ceste vynechajú, vyhľadávacie priečinky sa preskočia.
 */
function mailFolders(pst: PSTFile): MailFolder[] {
  const out: MailFolder[] = []
  const walk = (f: PSTFolder, path: string[], depth: number): void => {
    if (depth > MAX_DEPTH) return
    for (const sub of safe(() => f.getSubFolders(), [] as PSTFolder[])) {
      const name = safe(() => sub.displayName, '') || '?'
      const cls = safe(() => sub.containerClass, '')
      const count = safe(() => sub.contentCount, 0)
      const subs = safe(() => sub.subFolderCount, 0)
      if (depth === 0 && /search|vyhľadáv|suche/i.test(name) && count === 0) continue
      const skipName = depth === 0 && count === 0 && subs > 0
      const p = skipName ? path : [...path, name]
      if (!skipName && MAIL_FOLDER(cls)) out.push({ folder: sub, path: p })
      if (subs > 0) walk(sub, p, depth + 1)
    }
  }
  walk(pst.getRootFolder(), [], 0)
  return out
}

export function pstInfo(path: string): SourceInfo {
  const pst = openPst(path)
  try {
    const folders = mailFolders(pst)
    const messages = folders.reduce((n, f) => n + safe(() => f.folder.contentCount, 0), 0)
    return { format: 'pst', messages, folders: folders.filter((f) => safe(() => f.folder.contentCount, 0) > 0).length }
  } finally {
    pst.close()
  }
}

const hasAt = (s: string | null | undefined): s is string => !!s && /^[^\s@<>]+@[^\s@<>]+$/.test(s.trim())

/** Hlavičky ako zoznam riadkov (pokračovacie riadky spojené s predchádzajúcim). */
function headerLines(block: string): string[] {
  const out: string[] = []
  for (const line of block.replace(/\r\n|\r|\n/g, '\n').split('\n')) {
    if (!line) continue
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += `\r\n${line}`
    else if (/^[!-9;-~]*[A-Za-z][!-9;-~]*:/.test(line)) out.push(line)
  }
  return out
}

const headerName = (line: string): string => line.slice(0, line.indexOf(':')).trim()

function readAttachmentData(att: { fileInputStream: { length: { toNumber(): number }; readCompletely(b: Buffer): void } | null }): Buffer | null {
  const stream = att.fileInputStream
  if (!stream) return null
  const len = stream.length.toNumber()
  if (len < 0 || len > MAX_ATTACHMENT) return null
  const buf = Buffer.alloc(len)
  if (len) stream.readCompletely(buf)
  return buf
}

/** Zloží jednu správu Outlooku do tvaru RFC 5322. */
export async function buildMime(m: PSTMessage, depth = 0): Promise<Buffer> {
  const transport = safe(() => m.transportMessageHeaders, '')
  const original = headerLines(transport).filter((l) => !BODY_HEADERS.test(headerName(l)))
  const hasOriginal = original.some((l) => /^(from|date|subject|message-id):/i.test(l))

  const date = safe(() => m.messageDeliveryTime, null) ?? safe(() => m.clientSubmitTime, null) ?? undefined
  const subject = safe(() => m.subject, '')
  const seed = createHash('sha256')
    .update(`${safe(() => String(m.descriptorNodeId), '')}|${subject}|${date?.toISOString() ?? ''}|${safe(() => m.internetMessageId, '')}`)
    .digest('hex')
  const messageId = safe(() => m.internetMessageId, '') || `<doar-pst-${seed.slice(0, 24)}@import.doar>`

  const attachments: { filename: string; content: Buffer; contentType?: string; cid?: string }[] = []
  const n = safe(() => m.numberOfAttachments, 0)
  for (let i = 0; i < n; i++) {
    const att = safe(() => m.getAttachment(i), null)
    if (!att) continue
    const name = safe(() => att.longFilename, '') || safe(() => att.filename, '') || `priloha-${i + 1}`
    if (safe(() => att.attachMethod, 0) === 5) {
      const inner = safe(() => att.embeddedPSTMessage, null)
      if (inner && depth < 3) {
        const raw = await buildMime(inner, depth + 1).catch(() => null)
        if (raw) attachments.push({ filename: `${(safe(() => inner.subject, '') || 'sprava').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.eml`, content: raw, contentType: 'message/rfc822' })
      }
      continue
    }
    const data = safe(() => readAttachmentData(att as never), null)
    if (!data) continue
    const cid = safe(() => att.contentId, '').replace(/^<|>$/g, '')
    attachments.push({ filename: name, content: data, contentType: safe(() => att.mimeTag, '') || undefined, cid: cid || undefined })
  }

  const text = safe(() => m.body, '')
  const html = safe(() => m.bodyHTML, '')
  const addr = (name: string, address: string): { name: string; address: string } | string => (hasAt(address) ? { name: name || '', address: address.trim() } : name || '')
  const recipients = { to: [] as (string | { name: string; address: string })[], cc: [] as (string | { name: string; address: string })[], bcc: [] as (string | { name: string; address: string })[] }
  if (!hasOriginal) {
    const rn = safe(() => m.numberOfRecipients, 0)
    for (let i = 0; i < rn; i++) {
      const r = safe(() => m.getRecipient(i), null)
      if (!r) continue
      const a = addr(safe(() => r.displayName, ''), [safe(() => r.smtpAddress, ''), safe(() => r.emailAddress, '')].find(hasAt) ?? '')
      if (!a) continue
      const type = safe(() => r.recipientType, 1)
      ;(type === 2 ? recipients.cc : type === 3 ? recipients.bcc : recipients.to).push(a)
    }
  }
  const fromAddress = [safe(() => m.senderEmailAddress, ''), safe(() => m.sentRepresentingEmailAddress, '')].find(hasAt) ?? ''
  const fromName = safe(() => m.senderName, '') || safe(() => m.sentRepresentingName, '')

  const composer = new MailComposer({
    from: hasOriginal ? undefined : addr(fromName, fromAddress) || undefined,
    to: hasOriginal || !recipients.to.length ? undefined : recipients.to,
    cc: hasOriginal || !recipients.cc.length ? undefined : recipients.cc,
    bcc: hasOriginal || !recipients.bcc.length ? undefined : recipients.bcc,
    subject: hasOriginal ? undefined : subject,
    date,
    messageId,
    text: text || (html ? undefined : ''),
    html: html || undefined,
    attachments: attachments.length ? attachments : undefined,
    baseBoundary: seed.slice(0, 16)
  } as ConstructorParameters<typeof MailComposer>[0] & { baseBoundary: string })
  const node = composer.compile()
  node.keepBcc = true
  const built = await node.build()
  if (!hasOriginal) return built

  // Pôvodné hlavičky (Received, From, Date…) + hlavičky tela z novej správy.
  const s = built.toString('latin1')
  const end = s.indexOf('\r\n\r\n')
  const mimeHead = headerLines(s.slice(0, end)).filter((l) => BODY_HEADERS.test(headerName(l)))
  return Buffer.concat([Buffer.from([...original, ...mimeHead].join('\r\n') + '\r\n', 'latin1'), Buffer.from(s.slice(end + 2), 'latin1')])
}

export async function* readPst(path: string, opts: { signal?: AbortSignal; onSkip?: () => void } = {}): AsyncGenerator<SourceMessage> {
  const pst = openPst(path)
  try {
    for (const { folder, path: segs } of mailFolders(pst)) {
      const count = safe(() => folder.contentCount, 0)
      if (!count) continue
      for (let i = 0; i < count + 1; i++) {
        if (opts.signal?.aborted) return
        let item: unknown
        try {
          item = folder.getNextChild()
        } catch {
          opts.onSkip?.()
          continue
        }
        if (!item) break
        const m = item as PSTMessage
        if (!MAIL_CLASS.test(safe(() => m.messageClass, ''))) continue
        let msg: SourceMessage
        try {
          const raw = await buildMime(m)
          const flags = new Set<string>()
          if (safe(() => m.isRead, false)) flags.add('\\Seen')
          if (safe(() => (m as unknown as { getIntItem(id: number): number }).getIntItem(PR_FLAG_STATUS), 0) === 2) flags.add('\\Flagged')
          const verb = safe(() => m.lastVerbExecuted, 0)
          if (verb === VERB_REPLY || verb === VERB_REPLY_ALL) flags.add('\\Answered')
          if (verb === VERB_FORWARD) flags.add('$Forwarded')
          if (safe(() => m.isUnsent, false)) flags.add('\\Draft')
          msg = { raw, folder: segs, flags, internalDate: safe(() => m.messageDeliveryTime, null) ?? safe(() => m.clientSubmitTime, null) }
        } catch {
          opts.onSkip?.()
          continue
        }
        yield msg
        await yieldNow()
      }
    }
  } finally {
    pst.close()
  }
}
