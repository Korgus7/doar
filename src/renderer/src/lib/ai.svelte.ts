import type { AiConfig, AiProvider, AiRunInput, AiRunResult } from '../../../shared/ipc'
import { t, i18n, type MessageKey } from '../i18n/index.svelte'

/** Nastavenia AI v rozhraní (každé okno si ich načíta samo). */
export const ai = $state({ config: null as AiConfig | null })

export async function loadAiConfig(): Promise<AiConfig | null> {
  try {
    ai.config = await window.doar.invoke('ai.config.get')
  } catch {
    ai.config = null
  }
  return ai.config
}

/** AI je zapnutá a nastavená (model, kľúč – lokálny server kľúč nepotrebuje). */
export function aiReady(c: AiConfig | null = ai.config): boolean {
  return !!c && c.enabled && !!c.model && (c.hasKey || c.provider === 'local')
}

export function providerName(p: AiProvider): string {
  return t(`ai.provider.${p}` as MessageKey)
}

/** „Anthropic · claude-haiku-5-5“ – komu sa obsah odošle. */
export function aiTarget(c: AiConfig | null = ai.config): string {
  return c ? `${providerName(c.provider)} · ${c.model}` : ''
}

export function aiErrorText(e: unknown): string {
  const err = e as { code?: string; message?: string } | null
  const key = `errors.${err?.code ?? 'UNKNOWN'}` as MessageKey
  const base = t(key) !== key ? t(key) : t('errors.generic', { message: err?.message ?? '' })
  // Pri chybách od poskytovateľa pridať jeho krátke vysvetlenie (napr. názov neznámeho modelu).
  const withDetail = ['AI_BAD_REQUEST', 'AI_FAILED', 'AI_MODEL', 'AI_FORBIDDEN', 'AI_CREDIT', 'AI_UNAVAILABLE']
  return err?.code && withDetail.includes(err.code) && err.message && !/^HTTP \d+$/.test(err.message) ? `${base} (${err.message})` : base
}

/** Text pre AI v okne správy a jeho miesto (na vrátenie výsledku). */
export interface AiSource {
  text: string
  from: number
  to: number
  selection: boolean
}

let seq = 0

/**
 * Spustí úlohu AI. Priebežný text (celý doterajší) ide do onText. Zrušenie cez vrátenú funkciu cancel.
 */
export function runAi(
  input: Omit<AiRunInput, 'requestId' | 'lang'>,
  onText: (soFar: string) => void
): { result: Promise<AiRunResult>; cancel: () => void } {
  const requestId = `${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
  let soFar = ''
  const off = window.doar.on('ai.chunk', (c) => {
    if (c.requestId !== requestId) return
    soFar += c.text
    onText(soFar)
  })
  const result = window.doar.invoke('ai.run', { ...input, requestId, lang: i18n.locale === 'en' ? 'en' : 'sk' }).finally(off)
  return { result, cancel: () => void window.doar.invoke('ai.cancel', { requestId }).catch(() => {}) }
}

/** Zhrnutie v čítačke: pre ktorú správu je otvorené; hotové zhrnutia (do zatvorenia aplikácie). */
export const aiUi = $state({ summaryFor: null as number | null })
export const summaries = new Map<number, { text: string; target: string; truncated: boolean }>()
