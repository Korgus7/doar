import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { simpleParser } from 'mailparser'

/**
 * Testovací server Microsoft Graph (len to, čo Doar používa): priečinky (aj vnorené, špeciálne podľa
 * „well-known“ mien), delta správ s odkazmi na ďalšie zmeny, originál správy (/$value), PATCH príznakov,
 * presun, mazanie, koncept a odoslanie v MIME, $filter podľa internetMessageId. ID sú nemenné ako pri ImmutableId.
 */

interface Folder {
  id: string
  displayName: string
  parent: string | null
  wellKnown?: string
}

interface Msg {
  id: string
  folder: string
  mime: Buffer
  isRead: boolean
  flagged: boolean
  isDraft: boolean
  internetMessageId: string | null
  subject: string
  from: { name: string; address: string } | null
  to: { name: string; address: string }[]
  cc: { name: string; address: string }[]
  received: string
  sent: string | null
  seq: number
}

const ROOT = 'root-folder'

export class FakeGraph {
  readonly folders = new Map<string, Folder>()
  readonly messages = new Map<string, Msg>()
  /** Odstránené/presunuté preč: kvôli delta (folder, id, seq). */
  private removed: { folder: string; id: string; seq: number }[] = []
  private seq = 1
  private idSeq = 1
  private server: http.Server | null = null
  base = ''
  token = 'graph-token'
  readonly requests: string[] = []
  /** Odoslané správy (MIME) – „doručenie“. */
  readonly sent: Buffer[] = []
  /** Napodobniť nedostupný server pri odoslaní (pred prijatím). */
  failSend: number | null = null
  /** Veľkosť stránky delta (pre test stránkovania). */
  pageSize = 50
  /** Zahodiť históriu zmien (delta odkazy prestanú platiť). */
  dropHistory(): void {
    this.minSeq = this.seq
  }
  private minSeq = 0

  constructor() {
    this.addFolder('Inbox', null, 'inbox')
    this.addFolder('Sent Items', null, 'sentitems')
    this.addFolder('Drafts', null, 'drafts')
    this.addFolder('Deleted Items', null, 'deleteditems')
    this.addFolder('Junk Email', null, 'junkemail')
    this.addFolder('Archive', null, 'archive')
    this.addFolder('Outbox', null, 'outbox')
  }

  private newId(prefix: string): string {
    return `${prefix}${this.idSeq++}-${randomBytes(4).toString('hex')}=`
  }

  addFolder(name: string, parent: string | null, wellKnown?: string): string {
    const id = this.newId('F')
    this.folders.set(id, { id, displayName: name, parent, wellKnown })
    return id
  }

  folderId(wellKnownOrName: string): string {
    for (const f of this.folders.values()) if (f.wellKnown === wellKnownOrName || f.displayName === wellKnownOrName) return f.id
    throw new Error(`no folder ${wellKnownOrName}`)
  }

  async addMessage(folder: string, mime: Buffer | string, opts: { isRead?: boolean; isDraft?: boolean } = {}): Promise<string> {
    const raw = Buffer.isBuffer(mime) ? mime : Buffer.from(mime)
    const p = await simpleParser(raw)
    const one = (a: unknown): { name: string; address: string }[] => {
      const list = Array.isArray(a) ? a : a ? [a] : []
      return list.flatMap((x: { value?: { name?: string; address?: string }[] }) => x.value ?? []).filter((v) => v.address).map((v) => ({ name: v.name ?? '', address: v.address! }))
    }
    const id = this.newId('M')
    this.messages.set(id, {
      id,
      folder: this.folders.has(folder) ? folder : this.folderId(folder),
      mime: raw,
      isRead: !!opts.isRead,
      flagged: false,
      isDraft: !!opts.isDraft,
      internetMessageId: p.messageId ?? null,
      subject: p.subject ?? '',
      from: one(p.from)[0] ?? null,
      to: one(p.to),
      cc: one(p.cc),
      received: new Date().toISOString(),
      sent: p.date ? p.date.toISOString() : null,
      seq: ++this.seq
    })
    return id
  }

  /** Zmena „z iného zariadenia“. */
  update(id: string, patch: Partial<Pick<Msg, 'isRead' | 'flagged'>>): void {
    const m = this.messages.get(id)!
    Object.assign(m, patch, { seq: ++this.seq })
  }

  remove(id: string): void {
    const m = this.messages.get(id)
    if (!m) return
    this.messages.delete(id)
    this.removed.push({ folder: m.folder, id, seq: ++this.seq })
  }

  move(id: string, folder: string): void {
    const m = this.messages.get(id)!
    this.removed.push({ folder: m.folder, id, seq: ++this.seq })
    m.folder = folder
    m.seq = ++this.seq
  }

  inFolder(folder: string): Msg[] {
    const f = this.folders.has(folder) ? folder : this.folderId(folder)
    return [...this.messages.values()].filter((m) => m.folder === f)
  }

  private json(m: Msg): Record<string, unknown> {
    const ea = (a: { name: string; address: string }) => ({ emailAddress: { name: a.name, address: a.address } })
    return {
      id: m.id,
      subject: m.subject,
      from: m.from ? ea(m.from) : null,
      toRecipients: m.to.map(ea),
      ccRecipients: m.cc.map(ea),
      receivedDateTime: m.received,
      sentDateTime: m.sent,
      isRead: m.isRead,
      isDraft: m.isDraft,
      flag: { flagStatus: m.flagged ? 'flagged' : 'notFlagged' },
      internetMessageId: m.internetMessageId,
      hasAttachments: false,
      parentFolderId: m.folder
    }
  }

  private folderJson(f: Folder): Record<string, unknown> {
    return { id: f.id, displayName: f.displayName, parentFolderId: f.parent ?? ROOT, childFolderCount: [...this.folders.values()].filter((x) => x.parent === f.id).length }
  }

  private resolveFolder(idOrWk: string): Folder | undefined {
    if (idOrWk === 'msgfolderroot') return { id: ROOT, displayName: '', parent: null }
    return this.folders.get(idOrWk) ?? [...this.folders.values()].find((f) => f.wellKnown === idOrWk)
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        void this.handle(req, Buffer.concat(chunks), res).catch((e) => {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'Internal', message: String(e) } }))
        })
      })
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1.0`
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()))
  }

  private async handle(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x')
    const method = req.method ?? 'GET'
    this.requests.push(`${method} ${u.pathname}${u.search}`)
    const send = (status: number, data?: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(data === undefined ? '' : JSON.stringify(data))
    }
    const fail = (status: number, code: string): void => send(status, { error: { code, message: code } })
    if (req.headers['authorization'] !== `Bearer ${this.token}`) return fail(401, 'InvalidAuthenticationToken')
    if (!/IdType="ImmutableId"/.test(String(req.headers['prefer'] ?? ''))) return fail(400, 'ImmutableIdRequired')
    const path = u.pathname.replace(/^\/v1\.0/, '')
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
    const readJson = (): Record<string, unknown> => (body.length ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : {})

    if (parts[0] !== 'me') return fail(404, 'ResourceNotFound')
    if (parts.length === 1) return send(200, { mail: 'test@outlook.com', userPrincipalName: 'test@outlook.com' })

    // --- priečinky ---
    if (parts[1] === 'mailFolders') {
      if (parts.length === 2) {
        if (method === 'GET') return send(200, { value: [...this.folders.values()].filter((f) => f.parent === null).map((f) => this.folderJson(f)) })
        if (method === 'POST') {
          const name = String(readJson()['displayName'] ?? '')
          if ([...this.folders.values()].some((f) => f.parent === null && f.displayName.toLowerCase() === name.toLowerCase())) return fail(409, 'ErrorFolderExists')
          return send(201, this.folderJson(this.folders.get(this.addFolder(name, null))!))
        }
      }
      const f = this.resolveFolder(parts[2]!)
      if (!f) return fail(404, 'ErrorItemNotFound')
      if (parts.length === 3) {
        if (method === 'GET') return send(200, this.folderJson(f))
        if (method === 'PATCH') {
          f.displayName = String(readJson()['displayName'] ?? f.displayName)
          return send(200, this.folderJson(f))
        }
        if (method === 'DELETE') {
          // Outlook: priečinok aj so správami do Odstránenej pošty.
          f.parent = this.folderId('deleteditems')
          return send(204)
        }
      }
      if (parts[3] === 'childFolders') {
        if (method === 'GET') return send(200, { value: [...this.folders.values()].filter((x) => x.parent === f.id).map((x) => this.folderJson(x)) })
        if (method === 'POST') {
          const name = String(readJson()['displayName'] ?? '')
          if ([...this.folders.values()].some((x) => x.parent === f.id && x.displayName.toLowerCase() === name.toLowerCase())) return fail(409, 'ErrorFolderExists')
          return send(201, this.folderJson(this.folders.get(this.addFolder(name, f.id))!))
        }
      }
      if (parts[3] === 'move' && method === 'POST') {
        const dest = this.resolveFolder(String(readJson()['destinationId']))
        if (!dest) return fail(404, 'ErrorItemNotFound')
        f.parent = dest.id === ROOT ? null : dest.id
        return send(201, this.folderJson(f))
      }
      if (parts[3] === 'messages' && parts[4] === 'delta' && method === 'GET') {
        const since = Number(u.searchParams.get('$deltatoken') ?? u.searchParams.get('since') ?? '0')
        if (since && since < this.minSeq) return fail(410, 'SyncStateNotFound')
        const upto = Number(u.searchParams.get('upto') ?? this.seq)
        const skip = Number(u.searchParams.get('skip') ?? '0')
        const changed = [...this.messages.values()].filter((m) => m.folder === f.id && m.seq > since && m.seq <= upto).map((m) => this.json(m))
        const gone = since ? this.removed.filter((r) => r.folder === f.id && r.seq > since && r.seq <= upto && !(this.messages.get(r.id)?.folder === f.id)).map((r) => ({ id: r.id, '@removed': { reason: 'deleted' } })) : []
        const all = [...changed, ...gone]
        const page = all.slice(skip, skip + this.pageSize)
        const self = `${this.base}/me/mailFolders/${encodeURIComponent(f.id)}/messages/delta`
        if (skip + this.pageSize < all.length) return send(200, { value: page, '@odata.nextLink': `${self}?since=${since}&upto=${upto}&skip=${skip + this.pageSize}` })
        return send(200, { value: page, '@odata.deltaLink': `${self}?$deltatoken=${upto}` })
      }
      if (parts[3] === 'messages' && parts.length === 4 && method === 'GET') {
        const filter = u.searchParams.get('$filter') ?? ''
        const m = /^internetMessageId eq '((?:[^']|'')*)'$/.exec(filter)
        const want = m ? m[1]!.replace(/''/g, "'") : null
        return send(200, { value: [...this.messages.values()].filter((x) => x.folder === f.id && (want === null || x.internetMessageId === want)).map((x) => ({ id: x.id })) })
      }
      return fail(404, 'ResourceNotFound')
    }

    // --- správy ---
    if (parts[1] === 'messages') {
      if (parts.length === 2 && method === 'POST') {
        // Koncept v MIME (telo = base64).
        const id = await this.addMessage(this.folderId('drafts'), Buffer.from(body.toString('utf8'), 'base64'), { isRead: true, isDraft: true })
        return send(201, this.json(this.messages.get(id)!))
      }
      const m = this.messages.get(parts[2]!)
      if (!m) return fail(404, 'ErrorItemNotFound')
      if (parts[3] === '$value' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'message/rfc822' }).end(m.mime)
        return
      }
      if (parts.length === 3 && method === 'PATCH') {
        const j = readJson()
        if (typeof j['isRead'] === 'boolean') m.isRead = j['isRead']
        const flag = j['flag'] as { flagStatus?: string } | undefined
        if (flag?.flagStatus) m.flagged = flag.flagStatus === 'flagged'
        m.seq = ++this.seq
        return send(200, this.json(m))
      }
      if (parts.length === 3 && method === 'DELETE') {
        this.remove(m.id)
        return send(204)
      }
      if (parts[3] === 'move' && method === 'POST') {
        const dest = this.resolveFolder(String(readJson()['destinationId']))
        if (!dest || dest.id === ROOT) return fail(404, 'ErrorItemNotFound')
        this.move(m.id, dest.id)
        return send(201, this.json(m))
      }
      return fail(404, 'ResourceNotFound')
    }

    if (parts[1] === 'sendMail' && method === 'POST') {
      if (this.failSend) return fail(this.failSend, 'ServiceUnavailable')
      const mime = Buffer.from(body.toString('utf8'), 'base64')
      this.sent.push(mime)
      // Kópia v Odoslaných (bez skrytej kópie, ako Outlook).
      await this.addMessage(this.folderId('sentitems'), mime, { isRead: true })
      return send(202)
    }
    return fail(404, 'ResourceNotFound')
  }
}
