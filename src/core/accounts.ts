import net from 'node:net'
import type { Db } from './store/db'
import { defaultSignatureText, listSignatures, setSignatureText } from './signatures'
import type { AccountDetails, AccountPatch, AccountSettings, AccountSummary, AddAccountInput, OAuthProvider, ServerSettings } from '../shared/ipc'
import { ACCOUNT_COLORS_VIVID } from '../shared/ipc'
import { passwordKey, type Secrets } from './secrets'
import { emailDomain } from './providers/discover'
import type { OAuthService } from './oauth/oauth'

/** Poskytovateľ prihlásenia podľa známeho poskytovateľa konta. */
export function oauthProviderOf(providerKey: string | null | undefined): OAuthProvider | null {
  return providerKey === 'microsoft' ? 'microsoft' : providerKey === 'gmail' ? 'google' : null
}

/** Farby kont v poradí pridávania (dobre rozlíšiteľné v svetlej aj tmavej téme). */
const COLORS = ACCOUNT_COLORS_VIVID

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

const SUMMARY_COLS = `id, email, name, color, display_name AS displayName`

/** Podpisy k údajom konta (predvolený aj ako čistý text). */
function withSignatures(db: Db, rows: Omit<AccountSummary, 'signature' | 'signatures'>[]): AccountSummary[] {
  const all = listSignatures(db)
  return rows.map((r) => {
    const signatures = all.filter((s) => s.accountId === r.id)
    return { ...r, signatures, signature: signatures.find((s) => s.isDefault)?.text.trim() ?? '' }
  })
}

export function listAccounts(db: Db): AccountSummary[] {
  return withSignatures(db, db.prepare(`SELECT ${SUMMARY_COLS} FROM accounts ORDER BY sort_order, id`).all() as unknown as AccountSummary[])
}

export function accountSummary(db: Db, id: number): AccountSummary | null {
  const r = db.prepare(`SELECT ${SUMMARY_COLS} FROM accounts WHERE id = ?`).get(id) as unknown as AccountSummary | undefined
  return r ? withSignatures(db, [r])[0]! : null
}

export function getAccount(db: Db, id: number): AccountDetails {
  const r = db
    .prepare(
      `SELECT ${SUMMARY_COLS}, username, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, save_sent_copy, password_storage, auth_type, provider_key,
              (SELECT COUNT(*) FROM outbox o WHERE o.account_id = accounts.id AND o.state IN ('queued','sending','error','uncertain')) AS pending
       FROM accounts WHERE id = ?`
    )
    .get(id) as
    | (AccountSummary & {
        username: string
        imap_host: string
        imap_port: number
        imap_security: 'tls' | 'starttls'
        smtp_host: string
        smtp_port: number
        smtp_security: 'tls' | 'starttls'
        save_sent_copy: number
        password_storage: 'os' | 'session'
        auth_type: 'password' | 'oauth2'
        provider_key: string | null
        pending: number
      })
    | undefined
  if (!r) throw err('NOT_FOUND', 'Konto neexistuje')
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    color: r.color,
    displayName: r.displayName,
    signature: defaultSignatureText(db, r.id),
    signatures: listSignatures(db, r.id),
    username: r.username,
    imap: { host: r.imap_host, port: r.imap_port, security: r.imap_security },
    smtp: { host: r.smtp_host, port: r.smtp_port, security: r.smtp_security },
    saveSentCopy: r.save_sent_copy === 1,
    passwordStorage: r.password_storage,
    authType: r.auth_type,
    oauthProvider: r.auth_type === 'oauth2' ? oauthProviderOf(r.provider_key) : null,
    pendingOutbox: r.pending
  }
}

/**
 * Nové poradie kont (zoznam priečinkov, spoločná doručená pošta, výber odosielateľa).
 * Musí obsahovať presne všetky kontá – inak by sa poradie rozbilo pri súbežnom pridaní/odstránení.
 */
export function reorderAccounts(db: Db, ids: unknown): void {
  const all = (db.prepare('SELECT id FROM accounts').all() as { id: number }[]).map((r) => r.id)
  if (!Array.isArray(ids) || ids.length !== all.length || new Set(ids).size !== ids.length || !ids.every((x) => all.includes(x as number))) {
    throw err('NOT_FOUND', 'Zoznam kont sa medzitým zmenil')
  }
  const st = db.prepare('UPDATE accounts SET sort_order = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    ids.forEach((id, i) => st.run(i, id as number))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Zmena údajov konta, ktoré nesúvisia s pripojením (meno, názov, farba, podpis, kópia v Odoslaných). */
export function updateAccount(db: Db, id: number, patch: AccountPatch): AccountSummary {
  if (!accountSummary(db, id)) throw err('NOT_FOUND', 'Konto neexistuje')
  const sets: string[] = []
  const args: (string | number)[] = []
  const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : null)
  const dn = text(patch?.displayName, 200)
  if (dn !== null) {
    sets.push('display_name = ?')
    args.push(dn.trim())
  }
  const name = text(patch?.name, 100)
  if (name !== null) {
    if (!name.trim()) throw err('INVALID_NAME', 'Názov konta nesmie byť prázdny')
    sets.push('name = ?')
    args.push(name.trim())
  }
  if (typeof patch?.color === 'string') {
    if (!/^#[0-9a-f]{6}$/i.test(patch.color)) throw err('INVALID_COLOR', 'Neplatná farba')
    sets.push('color = ?')
    args.push(patch.color.toLowerCase())
  }
  // Textový podpis (staršie rozhranie) → predvolený podpis konta.
  const sig = text(patch?.signature, 10_000)
  if (sig !== null) setSignatureText(db, id, sig)
  if (typeof patch?.saveSentCopy === 'boolean') {
    sets.push('save_sent_copy = ?')
    args.push(patch.saveSentCopy ? 1 : 0)
  }
  if (sets.length) db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  return accountSummary(db, id)!
}

/** Uloží nové nastavenia servera (už overené) a prípadne nové heslo – do toho istého úložiska ako doteraz. */
export async function saveServerSettings(
  db: Db,
  secrets: Secrets,
  sessionSecrets: Secrets,
  id: number,
  s: { username: string; imap: ServerSettings; smtp: ServerSettings },
  password?: string
): Promise<void> {
  const acc = getAccount(db, id)
  if (password) await (acc.passwordStorage === 'os' ? secrets : sessionSecrets).set(passwordKey(id), password)
  db.prepare(
    `UPDATE accounts SET username = ?, imap_host = ?, imap_port = ?, imap_security = ?, smtp_host = ?, smtp_port = ?, smtp_security = ? WHERE id = ?`
  ).run(s.username, s.imap.host, s.imap.port, s.imap.security, s.smtp.host, s.smtp.port, s.smtp.security, id)
}

/** Uložené heslo konta (na overenie nových nastavení servera bez opätovného zadania hesla). */
export async function storedPassword(db: Db, secrets: Secrets, sessionSecrets: Secrets, id: number): Promise<string | null> {
  const acc = getAccount(db, id)
  return (acc.passwordStorage === 'os' ? secrets : sessionSecrets).get(passwordKey(id))
}

/**
 * Uloží nové konto. Heslo ide do šifrovaného úložiska systému, alebo – ak to používateľ zvolil –
 * len do pamäte do zatvorenia aplikácie. Nikdy nie do databázy.
 */
export async function addAccount(db: Db, secrets: Secrets, sessionSecrets: Secrets, input: AddAccountInput, oauth?: OAuthService): Promise<AccountSummary> {
  const settings = validateSettings(input?.settings)
  const flowId = typeof input?.oauth?.flowId === 'string' ? input.oauth.flowId : null
  if (flowId) {
    if (!oauth) throw err('OAUTH_NOT_CONFIGURED', 'Prihlásenie cez poskytovateľa nie je dostupné')
    oauth.flowCredential(flowId) // OAUTH_REQUIRED, ak prihlásenie neprebehlo
    // Prihlásený účet je ten správny – adresa z prihlásenia má prednosť pred napísanou.
    const signedIn = oauth.flowEmail(flowId)
    if (signedIn && signedIn !== settings.email.toLowerCase()) {
      settings.email = signedIn
      settings.username = signedIn
    }
    const provider = oauth.flowProvider(flowId)
    if (provider) settings.providerKey = provider === 'google' ? 'gmail' : 'microsoft'
  } else if (typeof input.password !== 'string' || input.password.length === 0) throw err('PASSWORD_REQUIRED', 'Chýba heslo')
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SUMMARY_COLS}`
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
      flowId ? 'oauth2' : 'password',
      settings.username,
      settings.providerKey,
      settings.saveSentCopy ? 1 : 0,
      color,
      count,
      remember ? 'os' : 'session'
    ) as unknown as AccountSummary

  try {
    if (flowId) await oauth!.saveForAccount(flowId, row.id, remember ? 'os' : 'session')
    else await (remember ? secrets : sessionSecrets).set(passwordKey(row.id), input.password)
  } catch (e) {
    // Bez hesla by konto nefungovalo – radšej ho nevytvoríme vôbec.
    db.prepare('DELETE FROM accounts WHERE id = ?').run(row.id)
    throw err('SECRET_SAVE_FAILED', e instanceof Error ? e.message : 'Heslo sa nepodarilo uložiť')
  }
  return row
}
