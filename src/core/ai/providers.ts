/**
 * Pripojenie k AI poskytovateľom (bez Electronu): Anthropic Messages API a OpenAI-kompatibilné
 * rozhranie (OpenRouter, lokálny server – Ollama, LM Studio…). Odpoveď prichádza priebežne (SSE).
 */

import type { AiProvider } from '../../shared/ipc'

export type AiProviderId = AiProvider

export const AI_PROVIDERS: readonly AiProviderId[] = ['anthropic', 'openrouter', 'local']

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1'
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'
export const LOCAL_DEFAULT_URL = 'http://localhost:11434/v1'

export interface AiEndpoint {
  provider: AiProviderId
  /** Pre lokálny server adresa zadaná používateľom (overená cez checkBaseUrl), inak pevná. */
  baseUrl: string
  key: string | null
  model: string
}

export interface ChatRequest {
  system: string
  user: string
  maxTokens: number
}

export type FetchFn = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<Response>

export function aiError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra })
}

export function isAiProvider(v: unknown): v is AiProviderId {
  return typeof v === 'string' && (AI_PROVIDERS as readonly string[]).includes(v)
}

export function baseUrlOf(provider: AiProviderId, localUrl: string): string {
  if (provider === 'anthropic') return ANTHROPIC_URL
  if (provider === 'openrouter') return OPENROUTER_URL
  return checkBaseUrl(localUrl)
}

/**
 * Adresa lokálneho servera: https kamkoľvek, http len na tento počítač alebo do domácej siete
 * (nešifrované spojenie cez internet by prezradilo obsah pošty). Bez mena a hesla v adrese.
 */
export function checkBaseUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(String(raw ?? '').trim())
  } catch {
    throw aiError('AI_BAD_URL', 'Neplatná adresa servera')
  }
  if (u.username || u.password || u.search || u.hash) throw aiError('AI_BAD_URL', 'Adresa nesmie obsahovať meno, heslo ani parametre')
  if (u.protocol === 'http:') {
    if (!isLocalHost(u.hostname)) throw aiError('AI_INSECURE_URL', 'Nešifrované spojenie (http) je povolené len na tento počítač alebo do domácej siete')
  } else if (u.protocol !== 'https:') throw aiError('AI_BAD_URL', 'Adresa musí začínať http:// alebo https://')
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function headers(ep: AiEndpoint): Record<string, string> {
  if (ep.provider === 'anthropic') return { 'content-type': 'application/json', 'x-api-key': ep.key ?? '', 'anthropic-version': '2023-06-01' }
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (ep.key) h['authorization'] = `Bearer ${ep.key}`
  if (ep.provider === 'openrouter') h['x-title'] = 'Doar Mail'
  return h
}

/** Chybová odpoveď poskytovateľa → kód pre rozhranie (+ krátky text poskytovateľa, bez obsahu pošty). */
export function httpError(status: number, body: string): Error {
  let detail = ''
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message)
    if (typeof m === 'string') detail = m
  } catch {
    detail = body
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300)
  const code =
    status === 401
      ? 'AI_AUTH'
      : status === 402 || (status === 400 && /credit|balance|billing/i.test(detail))
        ? 'AI_CREDIT'
        : status === 403
          ? 'AI_FORBIDDEN'
          : status === 404
            ? 'AI_MODEL'
            : status === 413
              ? 'AI_TOO_LONG'
              : status === 429
                ? 'AI_RATE_LIMIT'
                : status >= 500
                  ? 'AI_UNAVAILABLE'
                  : status === 400
                    ? 'AI_BAD_REQUEST'
                    : 'AI_FAILED'
  return aiError(code, detail || `HTTP ${status}`, { status, detail })
}

/** Chyba siete (fetch) → kód. */
function netError(e: unknown, signal: AbortSignal | undefined, timedOut: boolean): Error {
  if ((e as { code?: string })?.code?.startsWith('AI_')) return e as Error
  if (timedOut) return aiError('AI_TIMEOUT', 'Poskytovateľ AI neodpovedá')
  if (signal?.aborted || (e as Error)?.name === 'AbortError') return aiError('AI_CANCELLED', 'Zrušené')
  return aiError('AI_NO_CONNECTION', 'Nepodarilo sa spojiť so serverom AI', { cause: String((e as { cause?: { code?: string } })?.cause?.code ?? '') })
}

/** Udalosti Server-Sent Events z tela odpovede. */
export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  // Zrušenie (aj časový limit) ukončí čakanie na ďalšiu časť, aj keď server mlčí.
  const onAbort = (): void => void reader.cancel().catch(() => {})
  signal?.addEventListener('abort', onAbort)
  if (signal?.aborted) onAbort()
  const dec = new TextDecoder()
  let buf = ''
  let event = ''
  let data: string[] = []
  const flush = (): { event: string; data: string } | null => {
    const out = data.length ? { event: event || 'message', data: data.join('\n') } : null
    event = ''
    data = []
    return out
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buf += done ? dec.decode() : dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1)
        if (line === '') {
          const ev = flush()
          if (ev) yield ev
        } else if (line.startsWith(':')) continue
        else {
          const c = line.indexOf(':')
          const field = c < 0 ? line : line.slice(0, c)
          const val = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '')
          if (field === 'event') event = val
          else if (field === 'data') data.push(val)
        }
      }
      if (done) break
    }
    // Posledný riadok bez konca riadku.
    if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''))
    else if (buf.startsWith('event:')) event = buf.slice(6).trim()
    const ev = flush()
    if (ev) yield ev
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

/** Časové limity: odpoveď servera do 60 s, medzi časťami textu najviac 90 s. */
const FIRST_RESPONSE_MS = 60_000
const IDLE_MS = 90_000

/**
 * Pošle požiadavku a priebežne odovzdáva text cez onText. Vráti celý text.
 * Nič iné nerobí – AI nemá žiadne nástroje (nemôže odosielať, mazať ani presúvať poštu).
 */
export async function streamChat(
  ep: AiEndpoint,
  req: ChatRequest,
  opts: { fetch: FetchFn; signal?: AbortSignal; onText?: (delta: string) => void; firstMs?: number; idleMs?: number }
): Promise<{ text: string; stop: string | null }> {
  const ctl = new AbortController()
  let timedOut = false
  const onAbort = (): void => ctl.abort()
  opts.signal?.addEventListener('abort', onAbort)
  if (opts.signal?.aborted) ctl.abort()
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, ms)
  }
  let text = ''
  let stop: string | null = null
  const push = (s: unknown): void => {
    if (typeof s !== 'string' || !s) return
    text += s
    opts.onText?.(s)
  }
  try {
    arm(opts.firstMs ?? FIRST_RESPONSE_MS)
    const anthropic = ep.provider === 'anthropic'
    const url = anthropic ? `${ep.baseUrl}/messages` : `${ep.baseUrl}/chat/completions`
    const body = anthropic
      ? { model: ep.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.user }], stream: true }
      : {
          model: ep.model,
          max_tokens: req.maxTokens,
          stream: true,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user }
          ]
        }
    const res = await opts.fetch(url, { method: 'POST', headers: headers(ep), body: JSON.stringify(body), signal: ctl.signal })
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''))
    arm(opts.idleMs ?? IDLE_MS)
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('text/event-stream') || !res.body) {
      // Server ignoroval „stream“ – celá odpoveď naraz.
      const j = (await res.json()) as {
        content?: { type?: string; text?: string }[]
        choices?: { message?: { content?: string }; finish_reason?: string }[]
        stop_reason?: string
      }
      if (anthropic) {
        for (const c of j.content ?? []) if (c.type === 'text') push(c.text)
      } else push(j.choices?.[0]?.message?.content)
      stop = j.stop_reason ?? j.choices?.[0]?.finish_reason ?? null
      return { text, stop }
    }
    for await (const ev of sseEvents(res.body, ctl.signal)) {
      arm(opts.idleMs ?? IDLE_MS)
      if (!anthropic && ev.data.trim() === '[DONE]') break
      let j: Record<string, unknown>
      try {
        j = JSON.parse(ev.data) as Record<string, unknown>
      } catch {
        continue
      }
      const errObj = j['error'] as { message?: string; type?: string } | undefined
      if (ev.event === 'error' || errObj) {
        const m = String(errObj?.message ?? 'Chyba poskytovateľa AI').slice(0, 300)
        throw aiError(errObj?.type === 'overloaded_error' ? 'AI_UNAVAILABLE' : 'AI_FAILED', m, { detail: m })
      }
      if (anthropic) {
        if (j['type'] === 'content_block_delta') {
          const d = j['delta'] as { type?: string; text?: string } | undefined
          if (d?.type === 'text_delta') push(d.text)
        } else if (j['type'] === 'message_delta') {
          stop = ((j['delta'] as { stop_reason?: string } | undefined)?.stop_reason ?? stop) || null
        } else if (j['type'] === 'message_stop') break
      } else {
        const ch = (j['choices'] as { delta?: { content?: string }; finish_reason?: string | null }[] | undefined)?.[0]
        push(ch?.delta?.content)
        if (ch?.finish_reason) stop = ch.finish_reason
      }
    }
    if (ctl.signal.aborted) throw netError(null, opts.signal, timedOut)
    return { text, stop }
  } catch (e) {
    throw netError(e, opts.signal, timedOut)
  } finally {
    if (timer) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** Zoznam modelov (zároveň overenie spojenia a – pri Anthropic a lokálnom serveri – kľúča). */
export async function listModels(ep: Omit<AiEndpoint, 'model'>, opts: { fetch: FetchFn; signal?: AbortSignal }): Promise<string[]> {
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, 20_000)
  const onAbort = (): void => ctl.abort()
  opts.signal?.addEventListener('abort', onAbort)
  try {
    const url = ep.provider === 'anthropic' ? `${ep.baseUrl}/models?limit=100` : `${ep.baseUrl}/models`
    const h = headers({ ...ep, model: '' })
    delete h['content-type']
    const res = await opts.fetch(url, { method: 'GET', headers: h, signal: ctl.signal })
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''))
    const j = (await res.json()) as { data?: { id?: unknown }[]; models?: { name?: unknown; model?: unknown }[] }
    const ids = (j.data ?? []).map((m) => m.id)
    // Ollama /api/tags (ak by adresa smerovala tam) – pre istotu aj „models“.
    for (const m of j.models ?? []) ids.push(m.model ?? m.name)
    return [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200))].slice(0, 1000)
  } catch (e) {
    throw netError(e, opts.signal, timedOut)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
