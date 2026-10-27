/**
 * Klient CardDAV (RFC 6352) s rozšírením sync-collection (RFC 6578) – len to, čo potrebuje synchronizácia adresára.
 * Prihlásenie tokenom (Bearer); Google pripúšťa len OAuth. Odpovede servera sú dáta, nie pokyny.
 */

export type DavFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'manual'; signal?: AbortSignal }) => Promise<Response>

export interface DavCard {
  href: string
  etag: string | null
  vcard: string
}

function derr(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra })
}

/* ---------------- XML (multistatus) ---------------- */

const decodeEntities = (s: string): string =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    if (k === 'amp') return '&'
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
  })

/** Všetky prvky s daným lokálnym menom (bez ohľadu na predponu menného priestoru). */
function elements(xml: string, local: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${local}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}\\s*>)`, 'gi')
  const out: string[] = []
  for (const m of xml.matchAll(re)) out.push(m[1] ?? '')
  return out
}

const first = (xml: string, local: string): string | null => {
  const e = elements(xml, local)
  return e.length ? e[0]! : null
}

/** Text prvku: bez značiek, entity dekódované, obsah CDATA doslovne. */
function text(xml: string | null): string {
  if (xml === null) return ''
  const parts: string[] = []
  const s = xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => {
      parts.push(c)
      return `\u0002${parts.length - 1}\u0003`
    })
    .replace(/<[^>]+>/g, '')
  return decodeEntities(s)
    .replace(/\u0002(\d+)\u0003/g, (_, i: string) => parts[Number(i)] ?? '')
    .trim()
}

export interface DavResponse {
  href: string
  /** Stav odpovede (sync-collection: 404 = zmazané). */
  status: number | null
  /** Vlastnosti so stavom 200. */
  props: string
}

export function parseMultistatus(xml: string): { responses: DavResponse[]; syncToken: string | null } {
  const responses: DavResponse[] = []
  for (const r of elements(xml, 'response')) {
    const href = text(first(r, 'href'))
    if (!href) continue
    const statusLine = elements(r.replace(/<(?:[\w.-]+:)?propstat\b[\s\S]*?<\/(?:[\w.-]+:)?propstat\s*>/gi, ''), 'status')[0]
    const status = statusLine ? Number(/\b(\d{3})\b/.exec(text(statusLine))?.[1] ?? NaN) : null
    const ok = elements(r, 'propstat')
      .filter((p) => /\b2\d\d\b/.test(text(first(p, 'status'))))
      .map((p) => first(p, 'prop') ?? '')
      .join('')
    responses.push({ href, status: Number.isFinite(status) ? status : null, props: ok })
  }
  // sync-token mimo odpovedí (RFC 6578)
  const tail = xml.replace(/<(?:[\w.-]+:)?response\b[\s\S]*?<\/(?:[\w.-]+:)?response\s*>/gi, '')
  const tok = first(tail, 'sync-token')
  return { responses, syncToken: tok === null ? null : text(tok) || null }
}

/* ---------------- klient ---------------- */

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>'
const MULTIGET_BATCH = 100
const MAX_REDIRECTS = 5

export class CardDavClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly fetchFn: DavFetch = (url, init) => fetch(url, init)
  ) {}

  private async request(
    method: string,
    url: string,
    opts: { body?: string; depth?: '0' | '1'; headers?: Record<string, string>; pass403?: boolean } = {}
  ): Promise<{ res: Response; url: string; body: string }> {
    let target = url
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}`, ...(opts.headers ?? {}) }
      if (opts.body !== undefined) headers['content-type'] ??= 'application/xml; charset=utf-8'
      if (opts.depth) headers['depth'] = opts.depth
      let res: Response
      try {
        res = await this.fetchFn(target, { method, headers, body: opts.body, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
      } catch {
        throw derr('NO_NETWORK', 'Server kontaktov nie je dostupný')
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location')
        if (!loc) break
        target = new URL(loc, target).toString()
        continue
      }
      const body = await res.text().catch(() => '')
      if (res.status === 401) throw derr('CONTACTS_PERMISSION', 'Server kontaktov odmietol prihlásenie', { detail: body.slice(0, 300) })
      if (res.status === 403 && !(opts.pass403 && /valid-sync-token/i.test(body))) {
        // Google: vypnuté API v projekte vs. chýbajúce oprávnenie (rozsah) pri prihlásení.
        const disabled = /SERVICE_DISABLED|has not been used|is disabled/i.test(body)
        throw derr(disabled ? 'CONTACTS_API_DISABLED' : 'CONTACTS_PERMISSION', 'Server kontaktov odmietol prístup', { detail: body.slice(0, 300), status: 403 })
      }
      return { res, url: target, body }
    }
    throw derr('CONTACTS_SERVER', 'Príliš veľa presmerovaní')
  }

  private static fail(res: Response, body: string, what: string): Error {
    return derr('CONTACTS_SERVER', `${what}: HTTP ${res.status}`, { status: res.status, detail: body.slice(0, 300) })
  }

  private async propfind(url: string, depth: '0' | '1', props: string): Promise<{ url: string; ms: ReturnType<typeof parseMultistatus> }> {
    const body = `${XML_HEAD}<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${props}</d:prop></d:propfind>`
    const r = await this.request('PROPFIND', url, { body, depth })
    if (r.res.status !== 207) throw CardDavClient.fail(r.res, r.body, 'PROPFIND')
    return { url: r.url, ms: parseMultistatus(r.body) }
  }

  /**
   * Nájde adresár (kolekciu) používateľa: .well-known → principal → addressbook-home-set → kolekcia.
   * Pri viacerých adresároch vyberie prvý (Google má jeden: „default“).
   */
  async discover(startUrl: string): Promise<string> {
    const p = await this.propfind(startUrl, '0', '<d:current-user-principal/><card:addressbook-home-set/><d:resourcetype/>')
    const abs = (h: string): string => new URL(h, p.url).toString()
    const props = p.ms.responses.map((r) => r.props).join('')
    if (/<(?:[\w.-]+:)?addressbook\b/i.test(first(props, 'resourcetype') ?? '')) return p.url
    let home = text(first(first(props, 'addressbook-home-set') ?? '', 'href')) || null
    if (!home) {
      const principal = text(first(first(props, 'current-user-principal') ?? '', 'href'))
      if (!principal) throw derr('CONTACTS_SERVER', 'Server neoznámil adresár')
      const q = await this.propfind(abs(principal), '0', '<card:addressbook-home-set/>')
      home = text(first(first(q.ms.responses.map((r) => r.props).join(''), 'addressbook-home-set') ?? '', 'href')) || null
      if (!home) throw derr('CONTACTS_SERVER', 'Server neoznámil adresár')
      home = new URL(home, q.url).toString()
    } else home = abs(home)
    const list = await this.propfind(home, '1', '<d:resourcetype/><d:displayname/>')
    const books = list.ms.responses.filter((r) => /<(?:[\w.-]+:)?addressbook\b/i.test(first(r.props, 'resourcetype') ?? ''))
    if (!books.length) throw derr('CONTACTS_SERVER', 'Server nemá žiadny adresár')
    return new URL(books[0]!.href, list.url).toString()
  }

  /** Zoznam kontaktov v kolekcii: adresa → ETag. */
  async listEtags(collection: string): Promise<Map<string, string | null>> {
    const p = await this.propfind(collection, '1', '<d:getetag/><d:resourcetype/>')
    const self = new URL(collection).pathname.replace(/\/$/, '')
    const out = new Map<string, string | null>()
    for (const r of p.ms.responses) {
      const href = new URL(r.href, p.url).toString()
      if (new URL(href).pathname.replace(/\/$/, '') === self) continue
      if (/<(?:[\w.-]+:)?collection\b/i.test(first(r.props, 'resourcetype') ?? '')) continue
      out.set(href, text(first(r.props, 'getetag')) || null)
    }
    return out
  }

  async syncToken(collection: string): Promise<string | null> {
    const p = await this.propfind(collection, '0', '<d:sync-token/>')
    return text(first(p.ms.responses.map((r) => r.props).join(''), 'sync-token')) || null
  }

  /**
   * Zmeny od posledného tokenu (RFC 6578). Neplatný token → chyba SYNC_TOKEN_INVALID (treba načítať všetko znova).
   */
  async syncCollection(collection: string, token: string): Promise<{ changed: Map<string, string | null>; removed: string[]; token: string | null }> {
    const body = `${XML_HEAD}<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[c]!)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`
    const r = await this.request('REPORT', collection, { body, depth: '1', pass403: true })
    if ([403, 409, 410].includes(r.res.status) || (r.res.status === 400 && /valid-sync-token/i.test(r.body))) throw derr('SYNC_TOKEN_INVALID', 'Neplatný synchronizačný token')
    if (r.res.status !== 207) throw CardDavClient.fail(r.res, r.body, 'sync-collection')
    const ms = parseMultistatus(r.body)
    const changed = new Map<string, string | null>()
    const removed: string[] = []
    const self = new URL(collection).pathname.replace(/\/$/, '')
    for (const resp of ms.responses) {
      const href = new URL(resp.href, r.url).toString()
      if (new URL(href).pathname.replace(/\/$/, '') === self) continue
      if (resp.status === 404) removed.push(href)
      else changed.set(href, text(first(resp.props, 'getetag')) || null)
    }
    return { changed, removed, token: ms.syncToken }
  }

  /** Obsah kontaktov (addressbook-multiget, po dávkach); ak ho server nepodporuje, po jednom cez GET. */
  async fetchCards(collection: string, hrefs: string[]): Promise<DavCard[]> {
    const out: DavCard[] = []
    for (let i = 0; i < hrefs.length; i += MULTIGET_BATCH) {
      const batch = hrefs.slice(i, i + MULTIGET_BATCH)
      const body = `${XML_HEAD}<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop>${batch
        .map((h) => `<d:href>${new URL(h).pathname.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</d:href>`)
        .join('')}</card:addressbook-multiget>`
      const r = await this.request('REPORT', collection, { body, depth: '1' })
      let missing = batch
      if (r.res.status === 207) {
        const got = new Set<string>()
        for (const resp of parseMultistatus(r.body).responses) {
          const data = first(resp.props, 'address-data')
          if (data === null || !text(data)) continue
          const href = new URL(resp.href, r.url).toString()
          got.add(new URL(href).pathname)
          out.push({ href, etag: text(first(resp.props, 'getetag')) || null, vcard: text(data) })
        }
        // Čo server v dávke nevrátil (alebo bez obsahu), načítať po jednom.
        missing = batch.filter((h) => !got.has(new URL(h).pathname))
      } else if (![400, 403, 404, 405, 415, 422, 501].includes(r.res.status)) throw CardDavClient.fail(r.res, r.body, 'multiget')
      for (const h of missing) {
        const g = await this.request('GET', h, { headers: { accept: 'text/vcard' } })
        if (g.res.status === 404) continue
        if (!g.res.ok) throw CardDavClient.fail(g.res, g.body, 'GET')
        out.push({ href: h, etag: g.res.headers.get('etag'), vcard: g.body })
      }
    }
    return out
  }

  async get(href: string): Promise<DavCard | null> {
    const g = await this.request('GET', href, { headers: { accept: 'text/vcard' } })
    if (g.res.status === 404 || g.res.status === 410) return null
    if (!g.res.ok) throw CardDavClient.fail(g.res, g.body, 'GET')
    return { href: g.url, etag: g.res.headers.get('etag'), vcard: g.body }
  }

  /**
   * Uloží kontakt. etag = zmena existujúceho (If-Match), null = nový (If-None-Match: *).
   * Výsledok: konečná adresa (server ju môže zmeniť) a nový ETag (ak ho server poslal); 412 → CONFLICT.
   */
  async put(href: string, vcard: string, etag: string | null): Promise<{ href: string; etag: string | null }> {
    const headers: Record<string, string> = { 'content-type': 'text/vcard; charset=utf-8' }
    if (etag) headers['if-match'] = etag
    else headers['if-none-match'] = '*'
    const r = await this.request('PUT', href, { body: vcard, headers })
    if (r.res.status === 412) throw derr('CONFLICT', 'Kontakt sa medzitým zmenil na serveri')
    if (!r.res.ok) throw CardDavClient.fail(r.res, r.body, 'PUT')
    const loc = r.res.headers.get('location')
    return { href: loc ? new URL(loc, r.url).toString() : r.url, etag: r.res.headers.get('etag') }
  }

  /** Zmaže kontakt; 404/410 (už zmazaný) je v poriadku, 412 → CONFLICT. */
  async remove(href: string, etag: string | null): Promise<void> {
    const r = await this.request('DELETE', href, { headers: etag ? { 'if-match': etag } : {} })
    if (r.res.status === 404 || r.res.status === 410) return
    if (r.res.status === 412) throw derr('CONFLICT', 'Kontakt sa medzitým zmenil na serveri')
    if (!r.res.ok) throw CardDavClient.fail(r.res, r.body, 'DELETE')
  }
}
