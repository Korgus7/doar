import { appendFileSync, mkdirSync, renameSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Diagnostický log bez obsahu pošty.
 * Citlivé polia sa vždy nahradia; nikdy nelogujeme heslá, tokeny, kľúče, telá ani predmety.
 */
const SENSITIVE = /^(pass(word)?|pwd|secret|token|access_?token|refresh_?token|api_?key|auth|authorization|body|html|text|subject|raw|content|snippet|attachment)s?$/i
const MAX_SIZE = 5 * 1024 * 1024

let logFile: string | null = null

export function initLog(dataDir: string): void {
  const dir = join(dataDir, 'logs')
  mkdirSync(dir, { recursive: true })
  logFile = join(dir, 'doar.log')
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[…]'
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), code: (value as { code?: unknown }).code }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[skryté]' : redact(v, depth + 1)
    return out
  }
  if (typeof value === 'string') return redactString(value)
  return value
}

/** Odstráni z textu prihlasovacie údaje, ktoré by sa mohli objaviť v chybových hláseniach. */
function redactString(s: string): string {
  return s
    .replace(/(AUTH(ENTICATE)?\s+\S+\s+)\S+/gi, '$1[skryté]')
    .replace(/(LOGIN\s+\S+\s+)\S+/gi, '$1[skryté]')
    .replace(/(Bearer\s+)\S+/gi, '$1[skryté]')
    .replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1…')
}

function write(level: string, scope: string, msg: string, data?: unknown): void {
  const line = `${new Date().toISOString()} ${level} [${scope}] ${redactString(msg)}${data === undefined ? '' : ' ' + JSON.stringify(redact(data))}\n`
  if (level !== 'DEBUG') process.stderr.write(line)
  if (!logFile) return
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_SIZE) renameSync(logFile, `${logFile}.1`)
    appendFileSync(logFile, line)
  } catch {
    // Log nesmie nikdy zhodiť aplikáciu.
  }
}

export function logger(scope: string) {
  return {
    debug: (msg: string, data?: unknown) => write('DEBUG', scope, msg, data),
    info: (msg: string, data?: unknown) => write('INFO', scope, msg, data),
    warn: (msg: string, data?: unknown) => write('WARN', scope, msg, data),
    error: (msg: string, data?: unknown) => write('ERROR', scope, msg, data)
  }
}
