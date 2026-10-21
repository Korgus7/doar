import MailComposer from 'nodemailer/lib/mail-composer'
import addressparser from 'nodemailer/lib/addressparser'
import { randomUUID } from 'node:crypto'
import { simpleParser } from 'mailparser'
import type { Address } from '../../shared/ipc'

/** Rozparsuje zoznam adries zadaný používateľom („Ján <jan@x.sk>, eva@y.sk“). Neplatné vráti zvlášť. */
export function parseAddressList(input: string): { valid: Address[]; invalid: string[] } {
  const valid: Address[] = []
  const invalid: string[] = []
  const flat = (list: ReturnType<typeof addressparser>): void => {
    for (const a of list) {
      if ('group' in a && Array.isArray(a.group)) flat(a.group)
      else if ('address' in a && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address ?? '')) valid.push({ name: a.name ?? '', address: a.address! })
      else if (a.name || ('address' in a && a.address)) invalid.push(('address' in a && a.address) || a.name)
    }
  }
  flat(addressparser(input.replace(/;/g, ',')))
  return { valid, invalid }
}

export interface ComposeInput {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  inReplyTo?: string | null
  references?: string[]
}

/**
 * Zloží správu. Vráti originál s hlavičkou Bcc (pre kópiu v Odoslaných – odosielateľ vidí, komu poslal skrytú kópiu)
 * a Message-ID. Na odoslanie sa Bcc odstráni (stripBcc), adresáti skrytej kópie idú len v obálke SMTP.
 */
export async function composeMessage(input: ComposeInput): Promise<{ raw: Buffer; messageId: string }> {
  const domain = input.from.address.split('@')[1] ?? 'doar.local'
  const messageId = `<${randomUUID()}@${domain}>`
  const mail = new MailComposer({
    from: input.from,
    to: input.to,
    cc: input.cc.length ? input.cc : undefined,
    bcc: input.bcc.length ? input.bcc : undefined,
    subject: input.subject,
    text: input.text,
    messageId,
    date: new Date(),
    inReplyTo: input.inReplyTo ?? undefined,
    references: input.references?.length ? input.references : undefined,
    textEncoding: 'quoted-printable',
    headers: { 'X-Mailer': 'Doar' }
  })
  const compiled = mail.compile()
  compiled.keepBcc = true
  const raw = await compiled.build()
  return { raw, messageId }
}

/** Odstráni hlavičku Bcc (vrátane pokračovacích riadkov) – správa sa tak dá bezpečne odoslať všetkým. */
export function stripBcc(raw: Buffer): Buffer {
  const s = raw.toString('latin1')
  const end = s.search(/\r?\n\r?\n/)
  const head = end < 0 ? s : s.slice(0, end)
  const rest = end < 0 ? '' : s.slice(end)
  const lines = head.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (/^bcc:/i.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^[ \t]/.test(line)) continue
    skipping = false
    out.push(line)
  }
  return Buffer.from(out.join('\r\n') + rest, 'latin1')
}

/** Údaje z pôvodnej správy potrebné na odpoveď. */
export interface ReplySource {
  messageId: string | null
  references: string[]
  from: Address[]
  replyTo: Address[]
  to: Address[]
  cc: Address[]
  subject: string
  date: string | null
  text: string
}

export async function replySource(raw: Buffer): Promise<ReplySource> {
  const p = await simpleParser(raw, { skipHtmlToText: false, skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true })
  const addrs = (a: typeof p.from | typeof p.to): Address[] => {
    const list = !a ? [] : Array.isArray(a) ? a : [a]
    return list.flatMap((o) => o.value.filter((v) => v.address).map((v) => ({ name: v.name ?? '', address: v.address! })))
  }
  const refs = typeof p.references === 'string' ? [p.references] : (p.references ?? [])
  return {
    messageId: p.messageId ?? null,
    references: refs,
    from: addrs(p.from),
    replyTo: addrs(p.replyTo),
    to: addrs(p.to),
    cc: addrs(p.cc),
    subject: p.subject ?? '',
    date: p.date ? p.date.toISOString() : null,
    text: (p.text ?? '').replace(/\r\n/g, '\n')
  }
}

/** „Re:“ len raz, aj keď pôvodný predmet už nejakú predponu má (Re:, RE:, Odp:, AW:, Fwd:…). */
export function replySubject(subject: string): string {
  const s = subject.trim()
  return /^(re|odp|aw|sv|vs)\s*(\[\d+\])?\s*:/i.test(s) ? s : `Re: ${s}`
}
