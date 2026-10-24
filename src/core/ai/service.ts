/**
 * AI v jadre: nastavenia (tabuľka settings, kľúč „ai“), kľúč v bezpečnom úložisku, spúšťanie úloh.
 * Obsah pošty odchádza len pri ai.run – teda len po kliknutí používateľa. AI nemá žiadne nástroje:
 * výsledok je len text (návrh), ktorý rozhranie ukáže a používateľ s ním naloží sám.
 */
import type { Db } from '../store/db'
import type { Secrets } from '../secrets'
import type { Address, AiConfig, AiConfigPatch, AiProvider, AiRunInput, AiRunResult, CoreEvents, EventChannel, MessageView } from '../../shared/ipc'
import { logger } from '../log'
import { aiError, baseUrlOf, checkBaseUrl, isAiProvider, listModels, LOCAL_DEFAULT_URL, streamChat, type AiEndpoint, type FetchFn } from './providers'
import { buildPrompt, cleanOutput, TRANSLATE_LANGS, type EmailForAi } from './prompts'

const log = logger('ai')

interface Stored {
  enabled: boolean
  provider: AiProvider
  models: Record<AiProvider, string>
  baseUrl: string
  confirm: boolean
}

const DEFAULTS: Stored = {
  enabled: false,
  provider: 'anthropic',
  models: { anthropic: 'claude-haiku-5-5', openrouter: '', local: '' },
  baseUrl: LOCAL_DEFAULT_URL,
  confirm: true
}

const SETTINGS_KEY = 'ai'
const MAX_RUNNING = 4
const STYLES = ['fix', 'formal', 'friendly', 'shorter', 'translate', 'custom'] as const
export const aiKeyName = (p: AiProvider): string => `ai:${p}:key`

export interface AiDeps {
  db: Db
  secrets: Secrets
  sessionSecrets: Secrets
  emit<E extends EventChannel>(ch: E, data: CoreEvents[E]): void
  /** Načítanie správy (rovnaká cesta ako pri zobrazení; aj archív). */
  getMessage(id: number): Promise<MessageView>
  fetch?: FetchFn
}

function addr(list: Address[]): string {
  return list
    .slice(0, 20)
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .join(', ')
}

function cleanKey(v: unknown): string {
  const k = typeof v === 'string' ? v.trim() : ''
  if (!k || k.length > 500 || /[\s\u0000-\u001f\u007f]/.test(k)) throw aiError('AI_BAD_KEY', 'Neplatný kľúč')
  return k
}

export class AiService {
  private running = new Map<string, AbortController>()

  constructor(private readonly deps: AiDeps) {}

  private get fetch(): FetchFn {
    return this.deps.fetch ?? ((url, init) => fetch(url, init))
  }

  private load(): Stored {
    const row = this.deps.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined
    const st: Stored = { ...DEFAULTS, models: { ...DEFAULTS.models } }
    if (!row) return st
    try {
      const v = JSON.parse(row.value_json) as Partial<Stored>
      if (typeof v.enabled === 'boolean') st.enabled = v.enabled
      if (isAiProvider(v.provider)) st.provider = v.provider
      if (typeof v.confirm === 'boolean') st.confirm = v.confirm
      if (typeof v.baseUrl === 'string') st.baseUrl = v.baseUrl
      for (const p of ['anthropic', 'openrouter', 'local'] as const) if (typeof v.models?.[p] === 'string') st.models[p] = v.models[p]
    } catch {
      // poškodené nastavenie → predvolené
    }
    return st
  }

  private save(st: Stored): void {
    this.deps.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(SETTINGS_KEY, JSON.stringify(st))
  }

  private async keyOf(p: AiProvider): Promise<{ key: string | null; storage: 'secure' | 'session' | null }> {
    const s = await this.deps.sessionSecrets.get(aiKeyName(p)).catch(() => null)
    if (s) return { key: s, storage: 'session' }
    const k = await this.deps.secrets.get(aiKeyName(p)).catch(() => null)
    return k ? { key: k, storage: 'secure' } : { key: null, storage: null }
  }

  async getConfig(): Promise<AiConfig> {
    const st = this.load()
    const k = await this.keyOf(st.provider)
    return {
      enabled: st.enabled,
      provider: st.provider,
      model: st.models[st.provider],
      baseUrl: st.baseUrl,
      confirm: st.confirm,
      hasKey: !!k.key,
      keyStorage: k.storage
    }
  }

  async setConfig(patch: AiConfigPatch): Promise<AiConfig> {
    const st = this.load()
    if (patch?.provider !== undefined) {
      if (!isAiProvider(patch.provider)) throw aiError('AI_BAD_PROVIDER', 'Neznámy poskytovateľ')
      st.provider = patch.provider
    }
    if (typeof patch?.enabled === 'boolean') st.enabled = patch.enabled
    if (typeof patch?.confirm === 'boolean') st.confirm = patch.confirm
    if (typeof patch?.model === 'string') st.models[st.provider] = patch.model.trim().slice(0, 200)
    if (typeof patch?.baseUrl === 'string') st.baseUrl = checkBaseUrl(patch.baseUrl)
    if (patch?.key === null) {
      await this.deps.secrets.delete(aiKeyName(st.provider)).catch(() => {})
      await this.deps.sessionSecrets.delete(aiKeyName(st.provider))
    } else if (patch?.key !== undefined) {
      const key = cleanKey(patch.key)
      if (await this.deps.secrets.available().catch(() => false)) {
        await this.deps.secrets.set(aiKeyName(st.provider), key)
        await this.deps.sessionSecrets.delete(aiKeyName(st.provider))
      } else {
        // Bez šifrovaného úložiska systému: kľúč len do zatvorenia aplikácie (nikdy nie v otvorenom texte na disku).
        await this.deps.sessionSecrets.set(aiKeyName(st.provider), key)
      }
    }
    this.save(st)
    log.info('nastavenia AI zmenené', { enabled: st.enabled, provider: st.provider, model: st.models[st.provider], keyChanged: patch?.key !== undefined })
    return this.getConfig()
  }

  private async endpoint(provider: AiProvider, baseUrl: string, model: string, keyOverride?: string): Promise<AiEndpoint> {
    const key = keyOverride !== undefined ? cleanKey(keyOverride) : (await this.keyOf(provider)).key
    if (!key && provider !== 'local') throw aiError('AI_NO_KEY', 'Chýba kľúč API')
    return { provider, baseUrl: baseUrlOf(provider, baseUrl), key, model }
  }

  async models(data: { provider: AiProvider; baseUrl?: string; key?: string }): Promise<{ models: string[] }> {
    if (!isAiProvider(data?.provider)) throw aiError('AI_BAD_PROVIDER', 'Neznámy poskytovateľ')
    const st = this.load()
    const key = typeof data.key === 'string' && data.key.trim() ? data.key : undefined
    const ep = await this.endpoint(data.provider, typeof data.baseUrl === 'string' ? data.baseUrl : st.baseUrl, '', key)
    const models = await listModels(ep, { fetch: this.fetch })
    log.info('modely AI načítané', { provider: data.provider, count: models.length })
    return { models }
  }

  private async email(id: unknown): Promise<EmailForAi> {
    if (!Number.isInteger(id) || id === 0) throw aiError('AI_NO_MESSAGE', 'Chýba správa')
    const v = await this.deps.getMessage(id as number)
    return { subject: v.subject, from: addr(v.from), to: addr([...v.to, ...v.cc]), date: v.date, text: v.text }
  }

  async run(input: AiRunInput): Promise<AiRunResult> {
    const st = this.load()
    if (!st.enabled) throw aiError('AI_DISABLED', 'AI je vypnutá')
    const requestId = typeof input?.requestId === 'string' ? input.requestId.slice(0, 100) : ''
    if (!requestId || this.running.has(requestId) || this.running.size >= MAX_RUNNING) throw aiError('AI_BUSY', 'AI práve pracuje')
    if (!['summary', 'reply', 'rewrite'].includes(input.task)) throw aiError('AI_BAD_TASK', 'Neznáma úloha')
    if (input.task === 'rewrite') {
      if (!STYLES.includes(input.style as (typeof STYLES)[number])) throw aiError('AI_BAD_TASK', 'Neznáma úprava')
      if (!String(input.text ?? '').trim()) throw aiError('AI_NO_TEXT', 'Chýba text')
      if (input.style === 'translate' && !TRANSLATE_LANGS.includes(String(input.targetLang))) throw aiError('AI_BAD_TASK', 'Neznámy jazyk')
      if (input.style === 'custom' && !String(input.instruction ?? '').trim()) throw aiError('AI_NO_INSTRUCTION', 'Chýba pokyn')
    }
    // ID sa vyhradí hneď (pred prvým await), aby rovnaká požiadavka nemohla bežať dvakrát.
    const ctl = new AbortController()
    this.running.set(requestId, ctl)
    const started = Date.now()
    let ep: AiEndpoint | null = null
    let truncated = false
    try {
      const model = st.models[st.provider]
      if (!model) throw aiError('AI_NO_MODEL', 'Nie je zvolený model')
      ep = await this.endpoint(st.provider, st.baseUrl, model)
      const email = input.task === 'rewrite' ? null : await this.email(input.messageId)
      const prompt = buildPrompt(input, email)
      truncated = prompt.truncated
      const r = await streamChat(ep, prompt, {
        fetch: this.fetch,
        signal: ctl.signal,
        onText: (text) => this.deps.emit('ai.chunk', { requestId, text })
      })
      const text = cleanOutput(r.text)
      if (!text) throw aiError('AI_EMPTY', 'AI nevrátila žiadny text')
      // Do logu nikdy obsah – len čo, kam a ako dlho.
      log.info('AI hotovo', { task: input.task, provider: ep.provider, model, ms: Date.now() - started, outChars: text.length, stop: r.stop, truncated })
      return { text, truncated: truncated || r.stop === 'max_tokens' || r.stop === 'length', provider: ep.provider, model }
    } catch (e) {
      const err = e as { code?: string; status?: number }
      log.warn('AI zlyhala', { task: input.task, provider: st.provider, model: st.models[st.provider], code: err.code, status: err.status })
      throw e
    } finally {
      this.running.delete(requestId)
    }
  }

  cancel(requestId: unknown): void {
    if (typeof requestId === 'string') this.running.get(requestId)?.abort()
  }
}
