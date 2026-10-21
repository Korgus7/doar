import net from 'node:net'
import type { Db } from './store/db'
import type { AccountSettings, AccountSummary, AddAccountInput, ServerSettings } from '../shared/ipc'
import { passwordKey, type Secrets } from './secrets'
import { emailDomain } from './providers/discover'

/** Farby kont v poradí pridávania (dobre rozlíšiteľné v svetlej aj tmavej téme). */
const COLORS = ['#3b82f6', '#e8590c', '#2f9e44', '#ae3ec9', '#0c8599', '#e03131', '#f08c00', '#5c7cfa']

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function validServer(s: ServerSettings | undefined): s is ServerSettings {
  if (!s || typeof s !== 'object') return false
  const hostOk = typeof s.host === 'string' && (net.isIP(s.host) !== 0 || /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(s.host))
  return hostOk && Number.isInteger(s.port) && s.port > 0 && s.port < 65536 && (s.security === 'tls' || s.security === 'starttls')
}

/** Overí a normalizuje nastavenia prichádzajúce z rozhrania (nedôverujeme im). */
export function validateSettings(input: unknown): AccountSettings {
  const s = input as Partial<AccountSettings> | null
  if (!s || typeof s !== 'object') throw err('INVALID_SETTINGS', 'Chýbajú nastavenia konta')
  if (typeof s.email !== 'string' || !emailDomain(s.email)) throw err('INVALID_EMAIL', 'Neplatná e-mailová adresa')
  if (!validServer(s.imap)) throw err('INVALID_IMAP', 'Neplatné nastavenia IMAP servera')
  if (!validServer(s.smtp)) throw err('INVALID_SMTP', 'Neplatné nastavenia SMTP servera')
  const username = typeof s.username === 'string' && s.username.trim() ? s.username.trim() : s.email.trim()
  return {
    email: s.email.trim(),
    displayName: typeof s.displayName === 'string' ? s.displayName.trim().slice(0, 200) : '',
    username: username.slice(0, 320),
    imap: { host: s.imap.host.trim().toLowerCase(), port: s.imap.port, security: s.imap.security },
    smtp: { host: s.smtp.host.trim().toLowerCase(), port: s.smtp.port, security: s.smtp.security },
    saveSentCopy: s.saveSentCopy !== false,
    providerKey: typeof s.providerKey === 'string' ? s.providerKey.slice(0, 40) : null
  }
}

export function listAccounts(db: Db): AccountSummary[] {
  return db.prepare('SELECT id, email, name, color FROM accounts ORDER BY sort_order, id').all() as unknown as AccountSummary[]
}

/**
 * Uloží nové konto. Heslo ide do šifrovaného úložiska systému, alebo – ak to používateľ zvolil –
 * len do pamäte do zatvorenia aplikácie. Nikdy nie do databázy.
 */
export async function addAccount(db: Db, secrets: Secrets, sessionSecrets: Secrets, input: AddAccountInput): Promise<AccountSummary> {
  const settings = validateSettings(input?.settings)
  if (typeof input.password !== 'string' || input.password.length === 0) throw err('PASSWORD_REQUIRED', 'Chýba heslo')
  const remember = input.rememberPassword !== false
  if (remember && !(await secrets.available())) {
    throw err('SECURE_STORAGE_UNAVAILABLE', 'Bezpečné úložisko hesiel systému nie je dostupné')
  }

  const exists = db
    .prepare('SELECT id FROM accounts WHERE lower(email) = lower(?) AND lower(imap_host) = lower(?)')
    .get(settings.email, settings.imap.host)
  if (exists) throw err('ACCOUNT_EXISTS', 'Toto konto už je pridané')

  const count = (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c
  const color = COLORS[count % COLORS.length]!
  const domain = emailDomain(settings.email) ?? ''

  const row = db
    .prepare(
      `INSERT INTO accounts (email, display_name, name, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security,
        auth_type, username, provider_key, save_sent_copy, color, sort_order, password_storage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?, ?)
       RETURNING id, email, name, color`
    )
    .get(
      settings.email,
      settings.displayName,
      domain,
      settings.imap.host,
      settings.imap.port,
      settings.imap.security,
      settings.smtp.host,
      settings.smtp.port,
      settings.smtp.security,
      settings.username,
      settings.providerKey,
      settings.saveSentCopy ? 1 : 0,
      color,
      count,
      remember ? 'os' : 'session'
    ) as unknown as AccountSummary

  try {
    await (remember ? secrets : sessionSecrets).set(passwordKey(row.id), input.password)
  } catch (e) {
    // Bez hesla by konto nefungovalo – radšej ho nevytvoríme vôbec.
    db.prepare('DELETE FROM accounts WHERE id = ?').run(row.id)
    throw err('SECRET_SAVE_FAILED', e instanceof Error ? e.message : 'Heslo sa nepodarilo uložiť')
  }
  return row
}
