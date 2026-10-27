import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Testovací server CardDAV napodobňujúci Google: .well-known → principal → adresár „default“,
 * PROPFIND, REPORT (sync-collection, addressbook-multiget), GET, PUT a DELETE s ETagmi, prihlásenie tokenom.
 * Zmeny „z mobilu“ sa robia priamo cez addCard / editCard / deleteCard.
 */

interface Card {
  etag: string
  vcard: string
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export class FakeCardDav {
  readonly cards = new Map<string, Card>()
  private log: { seq: number; path: string }[] = []
  private seq = 1
  private etagSeq = 1
  private server: http.Server | null = null
  base = ''
  /** Platný token. */
  token = 'carddav-token'
  /** Napodobniť chýbajúce oprávnenie (403 ako Google). */
  forbid = false
  /** Zahodiť históriu zmien – sync-token prestane platiť. */
  dropHistory(): void {
    this.log = []
    this.minSeq = this.seq
  }
  private minSeq = 1
  readonly requests: string[] = []

  static readonly PRINCIPAL = '/carddav/v1/principals/user@example.com/'
  static readonly HOME = '/carddav/v1/principals/user@example.com/lists/'
  static readonly BOOK = '/carddav/v1/principals/user@example.com/lists/default/'

  private touch(path: string): void {
    this.log.push({ seq: ++this.seq, path })
  }

  addCard(vcard: string, name = `c${this.etagSeq}`): string {
    const path = `${FakeCardDav.BOOK}${name}`
    this.cards.set(path, { etag: `"e${this.etagSeq++}"`, vcard })
    this.touch(path)
    return path
  }

  editCard(path: string, vcard: string): void {
    this.cards.set(path, { etag: `"e${this.etagSeq++}"`, vcard })
    this.touch(path)
  }

  deleteCard(path: string): void {
    this.cards.delete(path)
    this.touch(path)
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString('utf8')))
      req.on('end', () => this.handle(req, res, body))
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()))
  }

  private ms(responses: string[], extra = ''): string {
    return `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${responses.join('')}${extra}</d:multistatus>`
  }

  private resp(href: string, props: string, status = 200): string {
    return `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status} OK</d:status></d:propstat></d:response>`
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const path = decodeURIComponent(new URL(req.url ?? '/', this.base).pathname)
    this.requests.push(`${req.method} ${path}`)
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end('unauthorized')
      return
    }
    if (this.forbid) {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Request had insufficient authentication scopes."}}')
      return
    }
    const send = (status: number, xml: string, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8', ...headers }).end(xml)
    }
    if (req.method === 'PROPFIND') {
      if (path === '/.well-known/carddav') {
        res.writeHead(301, { location: FakeCardDav.PRINCIPAL }).end()
        return
      }
      if (path === FakeCardDav.PRINCIPAL) {
        send(207, this.ms([this.resp(path, `<d:current-user-principal><d:href>${FakeCardDav.PRINCIPAL}</d:href></d:current-user-principal><card:addressbook-home-set><d:href>${FakeCardDav.HOME}</d:href></card:addressbook-home-set><d:resourcetype><d:principal/></d:resourcetype>`)]))
        return
      }
      if (path === FakeCardDav.HOME) {
        send(207, this.ms([this.resp(FakeCardDav.HOME, '<d:resourcetype><d:collection/></d:resourcetype>'), this.resp(FakeCardDav.BOOK, '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>My Contacts</d:displayname>')]))
        return
      }
      if (path === FakeCardDav.BOOK) {
        if (req.headers.depth === '0') {
          send(207, this.ms([this.resp(path, `<d:sync-token>tok-${this.seq}</d:sync-token><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>`)]))
          return
        }
        const list = [this.resp(path, '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>')]
        for (const [p, c] of this.cards) list.push(this.resp(p, `<d:getetag>${esc(c.etag)}</d:getetag><d:resourcetype/>`))
        send(207, this.ms(list))
        return
      }
      res.writeHead(404).end()
      return
    }
    if (req.method === 'REPORT' && path === FakeCardDav.BOOK) {
      if (/sync-collection/.test(body)) {
        const tok = /<d:sync-token>tok-(\d+)<\/d:sync-token>/.exec(body)
        const since = tok ? Number(tok[1]) : NaN
        if (!Number.isFinite(since) || since < this.minSeq) {
          send(403, '<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>')
          return
        }
        const paths = [...new Set(this.log.filter((l) => l.seq > since).map((l) => l.path))]
        const out = paths.map((p) => {
          const c = this.cards.get(p)
          return c ? this.resp(p, `<d:getetag>${esc(c.etag)}</d:getetag>`) : `<d:response><d:href>${esc(p)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
        })
        send(207, this.ms(out, `<d:sync-token>tok-${this.seq}</d:sync-token>`))
        return
      }
      if (/addressbook-multiget/.test(body)) {
        const hrefs = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]!))
        const out = hrefs.map((h) => {
          const c = this.cards.get(h)
          return c
            ? this.resp(h, `<d:getetag>${esc(c.etag)}</d:getetag><card:address-data>${esc(c.vcard)}</card:address-data>`)
            : `<d:response><d:href>${esc(h)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
        })
        send(207, this.ms(out))
        return
      }
      res.writeHead(400).end()
      return
    }
    if (!path.startsWith(FakeCardDav.BOOK)) {
      res.writeHead(404).end()
      return
    }
    const cur = this.cards.get(path)
    if (req.method === 'GET') {
      if (!cur) res.writeHead(404).end()
      else res.writeHead(200, { 'content-type': 'text/vcard', etag: cur.etag }).end(cur.vcard)
      return
    }
    if (req.method === 'PUT') {
      const ifMatch = req.headers['if-match']
      const ifNone = req.headers['if-none-match']
      if ((ifNone === '*' && cur) || (ifMatch && (!cur || cur.etag !== ifMatch))) {
        res.writeHead(412).end()
        return
      }
      const etag = `"e${this.etagSeq++}"`
      this.cards.set(path, { etag, vcard: body })
      this.touch(path)
      res.writeHead(cur ? 204 : 201, { etag }).end()
      return
    }
    if (req.method === 'DELETE') {
      if (!cur) {
        res.writeHead(404).end()
        return
      }
      const ifMatch = req.headers['if-match']
      if (ifMatch && cur.etag !== ifMatch) {
        res.writeHead(412).end()
        return
      }
      this.deleteCard(path)
      res.writeHead(204).end()
      return
    }
    res.writeHead(405).end()
  }
}
