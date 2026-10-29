/**
 * Microsoft Graph (pošta v Outlook.com a Microsoft 365) cez HTTPS. Bez Electronu – testovateľné proti
 * falošnému serveru (premenná DOAR_GRAPH_TEST_URL alebo parameter `base`).
 *
 * Všetky požiadavky žiadajú nemenné ID (ImmutableId): ID správy platí aj po presune do iného priečinka.
 */
import { logger } from '../log'

const log = logger('graph')

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

export type GraphFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Buffer; signal?: AbortSignal }) => Promise<Response>

export interface GraphError extends Error {
  code: string
  status?: number
  graphCode?: string
  /** Požiadavka mohla na server dôjsť (prerušené spojenie, vypršaný čas) – pri odoslaní pošty nejasný výsledok. */
  uncertain?: boolean
}

function gerr(code: string, message: string, extra: Partial<GraphError> = {}): GraphError {
  return Object.assign(new Error(message), { code, ...extra }) as GraphError
}

/** Chybový kód Doaru podľa odpovede Graph. */
function codeFor(status: number, graphCode: string): string {
  if (status === 401) return 'AUTH_FAILED'
  if (graphCode === 'MailboxNotEnabledForRESTAPI' || graphCode === 'MailboxNotSupportedForRESTAPI') return 'GRAPH_MAILBOX'
  if (status === 403) return 'GRAPH_FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'FOLDER_EXISTS'
  if (status === 410) return 'GRAPH_GONE'
  if (status === 413) return 'GRAPH_TOO_LARGE'
  if (status === 429 || status === 503 || status === 504) return 'TIMEOUT'
  if (status >= 500) return 'PROTOCOL'
  return 'REJECTED'
}

export interface GraphRequest {
  /** JSON telo (Content-Type: application/json). */
  json?: unknown
  /** Iné telo (napr. MIME v base64 – Content-Type: text/plain). */
  body?: string
  contentType?: string
  /** Vrátiť surové bajty (napr. /$value – originál správy). */
  raw?: boolean
  headers?: Record<string, string>
}

export class GraphClient {
  constructor(
    private readonly token: (opts?: { fresh?: boolean }) => Promise<string>,
    private readonly opts: { base?: string; fetch?: GraphFetch; timeoutMs?: number } = {}
  ) {}

  get base(): string {
    return (this.opts.base ?? process.env['DOAR_GRAPH_TEST_URL'] ?? GRAPH_BASE).replace(/\/+$/, '')
  }

  private get fetchFn(): GraphFetch {
    return this.opts.fetch ?? ((url, init) => fetch(url, init as RequestInit))
  }

  /** Úplná adresa: relatívna cesta (/me/...) alebo odkaz zo servera (@odata.nextLink, deltaLink). */
  url(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      // Odkazy zo servera smú viesť len na ten istý server.
      let origin = ''
      try {
        origin = new URL(pathOrUrl).origin
      } catch {
        /* neplatná adresa */
      }
      if (origin !== new URL(this.base).origin) throw gerr('PROTOCOL', 'Neočakávaná adresa od servera')
      return pathOrUrl
    }
    return `${this.base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`
  }

  async request(method: string, path: string, req: GraphRequest = {}): Promise<{ status: number; json: unknown; bytes: Buffer | null; headers: Headers }> {
    let fresh = false
    for (let attempt = 0; ; attempt++) {
      const token = await this.token({ fresh })
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: req.raw ? '*/*' : 'application/json',
        prefer: 'IdType="ImmutableId"',
        ...(req.headers ?? {})
      }
      let body: string | undefined
      if (req.json !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(req.json)
      } else if (req.body !== undefined) {
        headers['content-type'] = req.contentType ?? 'text/plain'
        body = req.body
      }
      let res: Response
      try {
        res = await this.fetchFn(this.url(path), { method, headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000) })
      } catch (e) {
        const name = (e as { name?: string }).name
        const cause = String((e as { cause?: { code?: string } }).cause?.code ?? '')
        // Spojenie sa vôbec nenadviazalo → požiadavka určite neodišla. Inak (prerušené, čas) nevieme.
        const notSent = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'].includes(cause)
        throw gerr(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NO_NETWORK', 'Server Microsoft nie je dostupný', { uncertain: !notSent })
      }
      if (res.ok) {
        if (req.raw) return { status: res.status, json: null, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers }
        const text = await res.text()
        let json: unknown = null
        if (text) {
          try {
            json = JSON.parse(text)
          } catch {
            throw gerr('PROTOCOL', 'Neplatná odpoveď servera')
          }
        }
        return { status: res.status, json, bytes: null, headers: res.headers }
      }
      const text = await res.text().catch(() => '')
      let graphCode = ''
      let message = ''
      try {
        const j = JSON.parse(text) as { error?: { code?: string; message?: string } }
        graphCode = String(j.error?.code ?? '')
        message = String(j.error?.message ?? '')
      } catch {
        /* nie JSON */
      }
      // Token mohol medzitým prestať platiť – raz skúsiť s novým.
      if (res.status === 401 && !fresh) {
        fresh = true
        continue
      }
      // Preťaženie: počkať, koľko server povie (najviac 3 pokusy, najdlhšie 30 s). POST (napr. odoslanie) len pri 429/503 –
      // vtedy ho server určite nespracoval; pri 504 mohol.
      const retryable = res.status === 429 || res.status === 503 || (res.status === 504 && method !== 'POST')
      if (retryable && attempt < 3) {
        const after = Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt, 30)
        log.info('Graph je preťažený, ďalší pokus', { status: res.status, after })
        await new Promise((r) => setTimeout(r, after * 1000))
        continue
      }
      throw gerr(codeFor(res.status, graphCode), `Graph ${res.status} ${graphCode} ${message}`.trim().slice(0, 300), { status: res.status, graphCode })
    }
  }

  async get<T>(path: string, headers?: Record<string, string>): Promise<T> {
    return (await this.request('GET', path, { headers })).json as T
  }

  /** Všetky stránky zoznamu (@odata.nextLink). */
  async getAll<T>(path: string, headers?: Record<string, string>): Promise<T[]> {
    const out: T[] = []
    let next: string | undefined = path
    for (let i = 0; next && i < 1000; i++) {
      const page = (await this.request('GET', next, { headers })).json as { value?: T[]; '@odata.nextLink'?: string }
      out.push(...(page.value ?? []))
      next = page['@odata.nextLink']
    }
    return out
  }
}
