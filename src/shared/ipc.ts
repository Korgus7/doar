/**
 * Kontrakt komunikácie rozhranie ↔ core.
 * Každý kanál je tu vymenovaný; core odmietne všetko, čo tu nie je.
 */

export interface AccountSummary {
  id: number
  email: string
  name: string
  color: string
  /** Meno odosielateľa (From). */
  displayName: string
  /** Predvolený podpis ako čistý text (správa bez formátovania). */
  signature: string
  /** Podpisy konta (0.9): formátované, jeden môže byť predvolený. */
  signatures: Signature[]
}

export interface Signature {
  id: number
  accountId: number
  /** Názov na výber (prázdny = „Podpis 1“…). */
  name: string
  /** Formátovaný podpis (prečistené HTML, aj s logom). */
  html: string
  /** Čistý text podpisu. */
  text: string
  isDefault: boolean
}
export type SignatureInput = { id?: number; accountId: number; name: string; html: string; isDefault?: boolean }

/** Podrobnosti konta pre nastavenia (bez hesla). */
export interface AccountDetails extends AccountSummary {
  username: string
  imap: ServerSettings
  smtp: ServerSettings
  saveSentCopy: boolean
  passwordStorage: 'os' | 'session'
  /** Prihlásenie heslom, alebo cez účet poskytovateľa. */
  authType: 'password' | 'oauth2'
  oauthProvider: OAuthProvider | null
  /** Správy tohto konta, ktoré ešte čakajú na odoslanie (pri odstránení konta by sa stratili). */
  pendingOutbox: number
}

/** Stav synchronizácie adresára (kontakty Google cez CardDAV). */
export interface ContactSyncStatus {
  /** Kontá Google prihlásené cez Google – s nimi sa dá synchronizovať. */
  candidates: { accountId: number; email: string }[]
  enabled: null | { accountId: number; email: string; lastSync: string | null; lastError: string | null; running: boolean }
  /** Kontakty v Doare, ktoré ešte nie sú na serveri (pri zapnutí sa nahrajú). */
  localOnly: number
}

/** Kontakt v adresári (jedna e-mailová adresa). */
export interface Contact {
  id: number
  name: string
  email: string
  phone: string
  company: string
  note: string
  /** Poštová adresa (viac riadkov). */
  address: string
  /** Skupiny, v ktorých kontakt je (ID). */
  groups?: number[]
}

/** Skupina v adresári (napr. „Rodina“) – správa všetkým jedným klikom. */
export interface ContactGroup {
  id: number
  name: string
  /** Počet kontaktov v skupine. */
  count: number
  /** Z toho s e-mailom (komu sa dá napísať). */
  withEmail: number
}

/** Návrh adresáta: adresa, alebo celá skupina (vloží všetky adresy). */
export interface AddressSuggestion extends Address {
  group?: { id: number; members: Address[] }
}

/** Nový kontakt (bez id) alebo úprava existujúceho. */
export interface ContactInput {
  id?: number
  name: string
  email: string
  phone: string
  company: string
  note: string
  /** Poštová adresa (viac riadkov). */
  address: string
  /** Skupiny (ID); bez poľa = nemeniť. */
  groups?: number[]
}

/** Adresa z pošty (adresát odoslanej správy), ktorá ešte nie je v adresári. */
export interface MailAddressItem {
  email: string
  name: string
  count: number
}

export interface AccountPatch {
  displayName?: string
  name?: string
  color?: string
  signature?: string
  saveSentCopy?: boolean
}

/** Všeobecné nastavenia aplikácie (v databáze, tabuľka settings). */
export interface AppSettings {
  /** Upozorniť systémovým oznámením na novú poštu v doručenej pošte. */
  notifyNewMail: boolean
  /** V oznámení ukázať odosielateľa a predmet (inak len „Nová pošta“). */
  notifyShowContent: boolean
  /** Nové správy písať formátované (HTML); inak čistý text. */
  composeHtml: boolean
  /** Zoznam správ zoskupiť do konverzácií. */
  threads: boolean
}

/** Výrazné farby kont (od 0.7.1) – predvolené, nové kontá ich dostávajú postupne. Staré prevedie migrácia 012. */
export const ACCOUNT_COLORS_VIVID = ['#18a4d5', '#ff7614', '#9ddd08', '#793cf2', '#00cea8', '#f03a47', '#f7dd12', '#ed0da6'] as const
/** Tlmené farby na výber (paleta z 0.6). */
export const ACCOUNT_COLORS_MUTED = ['#4a6b96', '#b5683a', '#4f7f5a', '#7d5b8f', '#3f7f84', '#a3504a', '#b08a3e', '#5f6f8f'] as const
/** Neutrálna sivá – pre toho, kto farby kont nechce. */
export const ACCOUNT_COLOR_NEUTRAL = '#8a8f98'
/** Všetky farby, ktoré ponúkajú nastavenia. */
export const ACCOUNT_COLORS = [...ACCOUNT_COLORS_VIVID, ...ACCOUNT_COLORS_MUTED, ACCOUNT_COLOR_NEUTRAL] as const

export interface AppInfo {
  version: string
  coreNode: string
  sqlite: string
  dataDir: string
  secureStorage: boolean
}

export type Security = 'tls' | 'starttls'

export interface ServerSettings {
  host: string
  port: number
  security: Security
}

/** Nastavenia konta, ktoré používateľ vidí a môže upraviť v sprievodcovi. */
export interface AccountSettings {
  email: string
  displayName: string
  username: string
  imap: ServerSettings
  smtp: ServerSettings
  /** Ukladať kópiu odoslanej pošty do Odoslaných (server to nerobí sám). */
  saveSentCopy: boolean
  providerKey: string | null
}

export type DiscoverySource = 'known' | 'srv' | 'autoconfig' | 'ispdb' | 'mx' | 'guess' | 'none'

/** Prihlásenie cez účet poskytovateľa (OAuth) namiesto hesla. */
export type OAuthProvider = 'microsoft' | 'google'

export interface DiscoveryResult {
  /** Navrhnuté nastavenia; pri `source = 'none'` len predvyplnený návrh na ručnú úpravu. */
  settings: AccountSettings
  source: DiscoverySource
  /** Poskytovateľ vyžaduje prihlásenie, ktoré zatiaľ nepodporujeme (napr. OAuth Microsoft). */
  unsupportedAuth: 'oauth2' | null
  /** Poskytovateľ vyžaduje heslo aplikácie (napr. Gmail). */
  needsAppPassword: boolean
  /** Dá sa prihlásiť cez účet poskytovateľa (OAuth) – ak je v tejto zostave nastavený. */
  oauth: OAuthProvider | null
}

/** Kódy chýb pri overovaní spojenia – rozhranie ich prekladá do zrozumiteľných viet. */
export type ConnectionErrorCode =
  | 'NO_NETWORK'
  | 'AUTH_FAILED'
  | 'HOST_NOT_FOUND'
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'CERT_UNTRUSTED'
  | 'CERT_EXPIRED'
  | 'CERT_HOSTNAME'
  | 'TLS_FAILED'
  | 'STARTTLS_UNSUPPORTED'
  | 'PROTOCOL'
  | 'UNKNOWN'

export interface ProtocolTestResult {
  ok: boolean
  code?: ConnectionErrorCode
  /** Technický detail pre pokročilých (bez hesla). */
  detail?: string
  /** Pri CERT_HOSTNAME: mená, pre ktoré certifikát platí (návrh správneho servera). */
  certHosts?: string[]
}

export interface ConnectionTestResult {
  imap: ProtocolTestResult
  smtp: ProtocolTestResult
}

export interface AddAccountInput {
  settings: AccountSettings
  /** Heslo; pri prihlásení cez účet poskytovateľa prázdne a namiesto neho `oauth`. */
  password: string
  /** Dokončené prihlásenie cez poskytovateľa (oauth.start → oauth.finish). */
  oauth?: { flowId: string }
  /** false = heslo len do zatvorenia aplikácie (keď nie je bezpečné úložisko). */
  rememberPassword: boolean
}

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged' | 'important'

export interface FolderItem {
  id: number
  accountId: number
  path: string
  name: string
  parentPath: string | null
  specialUse: SpecialUse | null
  selectable: boolean
  unread: number
  /** Počet správ na serveri pri poslednej synchronizácii. */
  total: number
  /** Počet správ v lokálnej kópii. */
  localCount: number
  depth: number
}

export interface MessageListItem {
  id: number
  accountId: number
  folderId: number
  subject: string
  fromName: string
  fromAddr: string
  to: string[]
  date: string | null
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  snippet: string
  localState: 'synced' | 'pending' | 'failed'
  downloaded: boolean
  accountColor: string
  accountName: string
  /** Zobrazenie po konverzáciách: všetky správy konverzácie v tomto priečinku (táto je najnovšia). */
  threadIds?: number[]
  /** Mená odosielateľov v konverzácii (v poradí od najstaršieho, bez opakovania). */
  threadFrom?: string[]
}

/** Správa v konverzácii (pre čítanie – zo všetkých priečinkov konta okrem Koša a Spamu). */
export interface ThreadMessage {
  id: number
  folderId: number
  fromName: string
  fromAddr: string
  date: string | null
  snippet: string
  seen: boolean
  flagged: boolean
  hasAttachments: boolean
}

export interface Address {
  name: string
  address: string
}

export type AttachmentPreview = { kind: 'image'; dataUrl: string } | { kind: 'text'; text: string } | { kind: 'pdf'; path: string }

/** Druh náhľadu prílohy podľa typu a prípony (null = náhľad nie je). */
export function previewKind(filename: string, contentType: string): 'image' | 'text' | 'pdf' | null {
  const ext = (filename.split('.').pop() ?? '').toLowerCase()
  const type = (contentType ?? '').toLowerCase()
  if (/^image\/(png|jpe?g|gif|webp|bmp)$/.test(type) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image'
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (/^text\/(plain|csv)$/.test(type) || ['txt', 'csv', 'log'].includes(ext)) return 'text'
  return null
}

export interface AttachmentInfo {
  index: number
  filename: string
  contentType: string
  size: number
}

export interface MessageView {
  id: number
  accountId: number
  subject: string
  from: Address[]
  to: Address[]
  cc: Address[]
  replyTo: Address[]
  date: string | null
  /** Sanitizované HTML (bez skriptov, vzdialený obsah odstránený), alebo null pri čisto textovej správe. */
  html: string | null
  text: string
  attachments: AttachmentInfo[]
  /** Počet zablokovaných vzdialených obrázkov. */
  remoteBlocked: number
  /** Vzdialené obrázky sú zobrazené (vložené ako data: URI). */
  remoteShown: boolean
  /** Odosielateľ má trvalo povolený vzdialený obsah. */
  senderAllowed: boolean
  /** Správa ponúka odhlásenie z odberu (hlavička List-Unsubscribe): ako sa vykoná. */
  unsubscribe: 'oneClick' | 'mailto' | 'url' | null
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error'

export interface SyncStatus {
  accountId: number
  state: SyncState
  /** Kód chyby (AUTH_FAILED, PASSWORD_REQUIRED, …) pri state = error/offline. */
  code?: string
  /** Priebeh sťahovania originálov. */
  pendingBodies: number
  /** Zmeny (príznaky, presuny, koncepty) a správy, ktoré čakajú na server – napr. bez pripojenia. */
  pendingChanges: number
  lastSync: string | null
}

/** Chyby spojenia, pri ktorých ide o nedostupnosť siete/servera (nie o zlé nastavenie) – opakuje sa samo. */
export const OFFLINE_CODES: readonly string[] = ['NO_NETWORK', 'HOST_NOT_FOUND', 'CONNECTION_REFUSED', 'TIMEOUT', 'PROTOCOL']

export type OutboxState = 'draft' | 'queued' | 'sending' | 'sent' | 'error' | 'uncertain'

export interface OutboxItem {
  id: number
  accountId: number
  accountEmail: string
  subject: string
  recipients: string[]
  state: OutboxState
  sentCopyState: 'not_needed' | 'pending' | 'done' | 'failed'
  /** Kód chyby (napr. REJECTED, AUTH_FAILED, INTERRUPTED). */
  error: string | null
  createdAt: string
  /** Odoslať neskôr: kedy (ISO 8601); null = hneď. */
  sendAt: string | null
}

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'draft'

export function isComposeMode(v: unknown): v is ComposeMode {
  return v === 'new' || v === 'reply' || v === 'replyAll' || v === 'forward' || v === 'draft'
}

/** Príloha v okne správy: súbor z disku (povolený cez dialóg alebo pretiahnutie), alebo príloha inej správy (preposlanie). */
export type ComposeAttachment =
  | { kind: 'file'; path: string }
  | { kind: 'message'; messageId: number; index: number }
  /** Príloha uložená v koncepte (obsah je už v lokálnom úložisku). */
  | { kind: 'blob'; sha: string; name: string; contentType?: string }

/** Súbor vybraný v dialógu alebo pretiahnutý do okna. */
export interface PickedFile {
  path: string
  name: string
  size: number
}

/** Najväčšia celková veľkosť príloh jednej správy (pred zakódovaním). */
export const MAX_ATTACHMENTS_BYTES = 50 * 1024 * 1024
/** Nad touto veľkosťou upozorníme – mnohé servery neprijmú správu väčšiu než 20–25 MB. */
export const WARN_ATTACHMENTS_BYTES = 20 * 1024 * 1024

/**
 * Prípony súborov, ktoré by sa po otvorení spustili ako program. Doar ich nikdy neotvorí,
 * dajú sa len uložiť (a systém ich označí ako stiahnuté z internetu).
 */
const DANGEROUS_EXT = new Set(
  (
    'exe com scr pif bat cmd ps1 ps1xml ps2 psm1 psd1 vbs vbe js jse wsf wsh wsc hta msi msp mst cpl msc jar lnk url reg inf scf ' +
    'application appref-ms gadget vb sct shb shs chm hlp ade adp mde mda accde iso img vhd vhdx appx appxbundle msix msixbundle ' +
    'xll xlam ppam docm dotm xlsm xltm pptm potm app command sh run bin desktop'
  ).split(' ')
)
/** Podpriečinok dátového priečinka pre dočasné kópie otvorených príloh. */
export const OPEN_ATTACHMENTS_DIR = 'otvorene-prilohy'

export function isDangerousFile(name: string): boolean {
  const ext = /\.([^.\\/]+)$/.exec(name.trim().replace(/[.\s]+$/, ''))?.[1]?.toLowerCase()
  return !ext || DANGEROUS_EXT.has(ext)
}

export interface ComposePrefill {
  accountId: number
  to: Address[]
  cc: Address[]
  subject: string
  /** Údaje pôvodnej správy pre citáciu (text zostaví rozhranie v jazyku používateľa). */
  quote: { from: Address[]; date: string | null; text: string } | null
  /** Preposlanie: hlavička a text pôvodnej správy (blok zostaví rozhranie v jazyku používateľa). */
  forward: { from: Address[]; to: Address[]; cc: Address[]; date: string | null; subject: string; text: string } | null
  /** Prílohy pôvodnej správy (preposlanie) alebo konceptu – s odkazom, ktorý sa pošle pri odoslaní. */
  attachments: { source: ComposeAttachment; filename: string; size: number }[]
  replyToMessage: number | null
  /** Otvorený koncept (lokálne ID), inak null. */
  draftId: number | null
  /** Pri koncepte: polia a text presne tak, ako ich používateľ napísal (aj s neplatnou adresou). */
  draft: { to: string; cc: string; bcc: string; text: string; html: string | null } | null
}

/** Uloženie konceptu z okna správy. */
export interface DraftSaveInput {
  draftId: number | null
  accountId: number
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  replyToMessage: number | null
  attachments: ComposeAttachment[]
  /** Formátovaný text (HTML z editora), alebo null pri čistom texte. */
  html?: string | null
  /** Nahrať na server hneď (zatvorenie okna), nie až po odklade. */
  flush?: boolean
}

export interface ComposeSendInput {
  accountId: number
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  replyToMessage: number | null
  attachments?: ComposeAttachment[]
  /** Formátovaný text (HTML z editora). Jadro ho prečistí a textovú podobu vytvorí samo; null = čistý text. */
  html?: string | null
  /** Odoslaný koncept sa po zaradení do fronty zmaže (aj na serveri). */
  draftId?: number | null
  /** Odoslať neskôr: čas (ISO 8601). Správa čaká vo fronte; Doar ju odošle, keď beží. */
  sendAt?: string | null
}

/** Pravidlá pre novú poštu. */
export type RuleField = 'from' | 'to' | 'subject' | 'any'
export type RuleAction = 'move' | 'read' | 'flag' | 'archive' | 'trash'
export interface MailRule {
  id: number
  name: string
  enabled: boolean
  /** null = všetky kontá. */
  accountId: number | null
  field: RuleField
  /** Text, ktorý má pole obsahovať (bez ohľadu na veľké písmená a diakritiku). */
  value: string
  action: RuleAction
  /** Cieľ pri action = 'move'. */
  folderId: number | null
}
export type MailRuleInput = Omit<MailRule, 'id'> & { id?: number }

/** Šablóna správy (predmet a text na opakované použitie). */
export interface MailTemplate {
  id: number
  name: string
  subject: string
  /** Formátovaný text; null = čistý text. */
  html: string | null
  text: string
}

export type ExportPhase = 'scan' | 'check' | 'download' | 'write'

export interface ExportProgress {
  jobId: number
  accountId: number
  phase: ExportPhase
  foldersDone: number
  foldersTotal: number
  /** Počet správ v snímke (všetky priečinky). */
  messagesTotal: number
  /** Koľko originálov chýbalo v lokálnej kópii. */
  missing: number
  downloaded: number
  written: number
  bytes: number
}

export interface ExportFolderSummary {
  path: string
  specialUse: string | null
  expected: number
  exported: number
  /** Medzitým zmazané na serveri alebo zmenené UIDVALIDITY. */
  unavailable: number
  /** Chyba pri spracovaní (napr. poškodená lokálna kópia, ktorú sa nepodarilo stiahnuť znova). */
  failed: number
}

export type ExportResult = 'complete' | 'incomplete' | 'cancelled' | 'failed'

export interface ExportSummary {
  jobId: number
  accountId: number
  email: string
  result: ExportResult
  /** Pri result = failed: DISK_FULL, WRITE_FAILED, AUTH_FAILED, … */
  errorCode: string | null
  /** Výsledný súbor (pri neúplnej zálohe s „-NEUPLNA“), null ak súbor nevznikol. */
  path: string | null
  startedAt: string
  finishedAt: string
  sizeBytes: number
  gmail: boolean
  downloaded: number
  folders: ExportFolderSummary[]
  totals: { expected: number; exported: number; unavailable: number; failed: number }
}

export interface ExportState {
  running: ExportProgress | null
  last: ExportSummary | null
}

/** Názov súboru neúplnej zálohy: „záloha.mbox“ → „záloha-NEUPLNA.mbox“. */
export function incompletePath(path: string): string {
  return path.replace(/(\.mbox)?$/i, (ext) => `-NEUPLNA${ext || '.mbox'}`)
}

// ---------- obnova zo zálohy (import mbox do konta) ----------

/** restore = pôvodné priečinky podľa metadát Doar; single = všetko do jedného priečinka. */
export type ImportMode = 'restore' | 'single'

/** Cieľový priečinok (pri „single“ pre všetko, pri „restore“ pre správy bez metadát Doar). */
export type ImportTarget = { folderId: number } | { newName: string }

/** Odkiaľ pošta pochádza: mbox (záloha Doar, Thunderbird…), Windows Mail (.eml), Outlook Express (.dbx), Outlook (.pst/.ost). */
export type ImportFormat = 'mbox' | 'eml' | 'dbx' | 'pst'

export interface ImportPeek {
  path: string
  name: string
  /** Veľkosť súboru (pri priečinku 0). */
  sizeBytes: number
  /** Záloha vytvorená Doarom (blok metadát X-Doar-). */
  doar: boolean
  /** Konto, z ktorého záloha pochádza (X-Doar-Source). */
  source: string | null
  format: ImportFormat
  /** Počet správ a priečinkov (pri pošte z iných programov; pri mbox null). */
  messages: number | null
  folders: number | null
}

export type ImportPhase = 'scan' | 'folders' | 'check' | 'upload'

export interface ImportProgress {
  jobId: number
  accountId: number
  phase: ImportPhase
  fileName: string
  /** Čítanie súboru: bajty (mbox) alebo správy (prevod z iného programu). */
  scanUnit?: 'bytes' | 'messages'
  bytesRead: number
  fileSize: number
  messagesTotal: number
  foldersDone: number
  foldersTotal: number
  /** Koľko správ treba nahrať (po kontrole duplicít). */
  toUpload: number
  uploaded: number
  duplicates: number
  failed: number
}

export interface ImportFolderSummary {
  /** Cesta na serveri (segmenty oddelené „ / “). */
  path: string
  specialUse: SpecialUse | null
  total: number
  uploaded: number
  /** Už v priečinku boli (opakovaný import). */
  duplicate: number
  failed: number
  /** Ešte nenahrané (prerušenie, plná schránka). */
  pending: number
}

/** complete = všetko nahrané alebo už na serveri; partial = niektoré správy server odmietol; stopped/cancelled = dá sa pokračovať. */
export type ImportResult = 'complete' | 'partial' | 'stopped' | 'cancelled' | 'failed'

export interface ImportSummary {
  jobId: number
  accountId: number
  email: string
  fileName: string
  mode: ImportMode
  result: ImportResult
  /** OVERQUOTA, NO_NETWORK, AUTH_FAILED, FILE_CHANGED, NOT_MBOX, … */
  errorCode: string | null
  startedAt: string
  finishedAt: string
  folders: ImportFolderSummary[]
  totals: { total: number; uploaded: number; duplicate: number; failed: number; pending: number }
  /** Správy, ktorých blok Doar nesedí s obsahom (súbor upravil iný program). */
  changedOutside: number
  /** Správy bez metadát Doar (cudzí mbox). */
  foreign: number
  /** Správy, ktorým server neuložil vlastné štítky (kľúčové slová). */
  keywordsDropped: number
  /** Prázdne alebo nečitateľné záznamy v súbore. */
  skipped: number
  /** Dôvody odmietnutia jednotlivých správ: kód → počet. */
  failures: { code: string; count: number }[]
  /** Dá sa pokračovať (zrušené, prerušené, plná schránka…). */
  resumable: boolean
}

export interface ImportJobInfo {
  jobId: number
  accountId: number
  email: string
  fileName: string
  startedAt: string
  errorCode: string | null
  totals: ImportSummary['totals'] | null
}

export interface ImportState {
  running: ImportProgress | null
  last: ImportSummary | null
  /** Prerušené obnovy, v ktorých sa dá pokračovať. */
  resumable: ImportJobInfo[]
}

// ---------- lokálny archív (súbor mbox len na čítanie) ----------

export type ArchiveState = 'indexing' | 'ready' | 'missing' | 'failed'

export interface ArchiveSummary {
  id: number
  name: string
  path: string
  state: ArchiveState
  messageCount: number
  sizeBytes: number
  /** Záloha z Doaru (priečinky podľa metadát). */
  doar: boolean
  source: string | null
  /** Pri state = failed: NOT_MBOX, … */
  error: string | null
  /** Priebeh načítania (state = indexing). */
  progress: { bytesRead: number; fileSize: number; messages: number } | null
}

/**
 * Správy a priečinky archívu majú v rozhraní záporné ID (−id v databáze archívu), aby sa nemiešali
 * so správami kont. Rovnaké požiadavky (messages.list, messages.get, prílohy…) tak fungujú pre oboje.
 */
export function isArchiveId(id: number | null | undefined): boolean {
  return typeof id === 'number' && id < 0
}

/** Samostatné správy zo súborov .eml majú ID od tejto hodnoty nižšie (archívy sú −1, −2, …). */
export const EML_ID_BASE = -1_500_000_000
export function isEmlId(id: number | null | undefined): boolean {
  return typeof id === 'number' && id <= EML_ID_BASE
}

/** Požiadavky (invoke): kanál → [vstup, výstup]. */
/** AI (voliteľné): poskytovateľ, model, kľúč v bezpečnom úložisku. */
export type AiProvider = 'anthropic' | 'openrouter' | 'local'
export type AiTask = 'summary' | 'reply' | 'rewrite'
export type AiRewriteStyle = 'fix' | 'formal' | 'friendly' | 'shorter' | 'translate' | 'custom'

export interface AiConfig {
  enabled: boolean
  provider: AiProvider
  /** Model zvoleného poskytovateľa (pre každého poskytovateľa sa pamätá zvlášť). */
  model: string
  /** Adresa lokálneho servera (OpenAI-kompatibilné API). */
  baseUrl: string
  /** Pred zhrnutím sa opýtať (čo a kam sa odošle). */
  confirm: boolean
  /** Je uložený kľúč pre zvoleného poskytovateľa? */
  hasKey: boolean
  /** Kde je kľúč: bezpečné úložisko systému, alebo len do zatvorenia aplikácie. */
  keyStorage: 'secure' | 'session' | null
}

export interface AiConfigPatch {
  enabled?: boolean
  provider?: AiProvider
  model?: string
  baseUrl?: string
  confirm?: boolean
  /** Nový kľúč pre zvoleného poskytovateľa; null = zmazať. */
  key?: string | null
}

export interface AiRunInput {
  /** Identifikátor od rozhrania – priebežný text prichádza v udalosti ai.chunk. */
  requestId: string
  task: AiTask
  /** Zhrnutie a návrh odpovede: správa (aj z archívu). Prílohy sa neodosielajú. */
  messageId?: number
  /** Úprava: text na úpravu; odpoveď: už napísaný začiatok odpovede. */
  text?: string
  style?: AiRewriteStyle
  /** Preklad: kód jazyka (sk, en, de…). */
  targetLang?: string
  /** Vlastný pokyn používateľa. */
  instruction?: string
  /** Jazyk rozhrania (jazyk zhrnutia). */
  lang: UiLocale
}

export interface AiRunResult {
  text: string
  /** Vstup bol pridlhý a odstrihol sa. */
  truncated: boolean
  provider: AiProvider
  model: string
}

export interface CoreRequests {
  'app.info': [void, AppInfo]
  'accounts.list': [void, AccountSummary[]]
  'accounts.discover': [{ email: string; displayName: string }, DiscoveryResult]
  'accounts.test': [{ settings: AccountSettings; password: string; oauth?: { flowId: string } }, ConnectionTestResult]
  'accounts.add': [AddAccountInput, AccountSummary]
  'folders.list': [void, FolderItem[]]
  /** threads = zoskupiť do konverzácií (jeden riadok = najnovšia správa konverzácie v priečinku). */
  'messages.list': [{ folderId: number | null; offset: number; limit: number; threads?: boolean }, { total: number; items: MessageListItem[] }]
  /** Konverzácia, do ktorej správa patrí (zoradená od najstaršej). */
  'messages.thread': [{ id: number }, ThreadMessage[]]
  'messages.get': [{ id: number; showRemote?: boolean; alwaysForSender?: boolean }, MessageView]
  'messages.setFlags': [{ ids: number[]; seen?: boolean; flagged?: boolean }, void]
  /** Všetky správy v priečinku (null = spoločná doručená pošta) označí ako prečítané. */
  /** Uloží originál správy (.eml) do súboru zvoleného v dialógu „Uložiť ako“. */
  'messages.saveEml': [{ id: number; path: string }, void]
  /** Riadok zoznamu pre jednu správu (okno správy). null = správa už neexistuje. */
  'messages.item': [{ id: number }, MessageListItem | null]
  'messages.markFolderRead': [{ folderId: number | null }, { count: number }]
  'sync.now': [{ accountId?: number }, void]
  'sync.status': [void, SyncStatus[]]
  'compose.prepare': [{ mode: ComposeMode; messageId?: number }, ComposePrefill]
  'compose.send': [ComposeSendInput, { outboxId: number }]
  'outbox.list': [void, OutboxItem[]]
  'outbox.resolve': [{ id: number; action: 'resend' | 'discard' }, void]
  /** Naplánovaná správa: odoslať hneď, alebo zrušiť odoslanie (správa sa vráti medzi koncepty). */
  'outbox.scheduled': [{ id: number; action: 'sendNow' | 'cancel' }, { draftId: number | null }]
  'rules.list': [void, MailRule[]]
  'rules.save': [MailRuleInput, MailRule]
  'rules.delete': [{ id: number }, void]
  'rules.reorder': [{ ids: number[] }, void]
  /** Použije pravidlá (všetky zapnuté, alebo jedno) na správy v priečinku. */
  'rules.run': [{ folderId: number; ruleId?: number }, { applied: number }]
  'signatures.save': [SignatureInput, Signature]
  'signatures.delete': [{ id: number }, void]
  'signatures.setDefault': [{ accountId: number; id: number | null }, void]
  /** Logo do podpisu: obrázok vybraný v dialógu → data: URI. */
  'signatures.readImage': [{ path: string }, { dataUrl: string }]
  'templates.list': [void, MailTemplate[]]
  'templates.save': [Omit<MailTemplate, 'id'> & { id?: number }, MailTemplate]
  'templates.delete': [{ id: number }, void]
  'export.start': [{ accountId: number; path: string }, { jobId: number }]
  'export.cancel': [{ jobId: number }, void]
  'export.state': [void, ExportState]
  'messages.move': [{ ids: number[]; folderId?: number; special?: 'trash' | 'archive' | 'junk' | 'inbox' }, { undo: number[]; count: number }]
  'messages.deleteForever': [{ ids: number[] }, void]
  'messages.undo': [{ undo: number[] }, { undone: boolean }]
  'messages.listIds': [{ folderId: number | null; threads?: boolean }, number[]]
  'folders.create': [{ accountId: number; parentId: number | null; name: string }, { folderId: number }]
  /** Odstráni priečinok aj s podpriečinkami; správy presunie do Koša (Gmail: zruší len štítok). */
  'folders.delete': [{ folderId: number }, { moved: number; labelsOnly: boolean }]
  /** Premenuje priečinok a/alebo ho presunie pod iný (parentId null = najvyššia úroveň); podpriečinky idú s ním. */
  'folders.rename': [{ folderId: number; name: string; parentId: number | null }, void]
  'contacts.list': [{ query?: string; groupId?: number }, Contact[]]
  'contacts.groups': [void, ContactGroup[]]
  'contacts.groupSave': [{ id?: number; name: string }, ContactGroup]
  'contacts.groupDelete': [{ id: number }, void]
  /** Pridá / odoberie kontakty zo skupiny. */
  'contacts.groupMembers': [{ groupId: number; add?: number[]; remove?: number[] }, void]
  /** Adresy kontaktov skupiny (napísať skupine). */
  'contacts.groupAddresses': [{ groupId: number }, Address[]]
  'contacts.fromMail': [{ query?: string }, MailAddressItem[]]
  'contacts.save': [ContactInput, Contact]
  'contacts.delete': [{ ids: number[] }, void]
  'contacts.addFromMail': [{ emails: string[] }, { added: number }]
  /** Import zo súborov vCard (.vcf) alebo CSV vybraných v dialógu. */
  'contacts.import': [{ paths: string[] }, { added: number; updated: number; skipped: number }]
  /** Export do súboru vybraného v dialógu (.csv = CSV, inak vCard); ids = len vybrané kontakty. */
  'contacts.export': [{ path: string; ids?: number[] }, { count: number }]
  'contacts.syncStatus': [void, ContactSyncStatus]
  'contacts.syncEnable': [{ accountId: number }, void]
  'contacts.syncDisable': [void, void]
  /** Odhlásenie z odberu: jedným klikom alebo e-mailom za používateľa; 'url' = stránku otvorí rozhranie v prehliadači. */
  'messages.unsubscribe': [{ id: number }, { done: 'oneClick' | 'mailto' } | { open: string }]
  'contacts.syncNow': [void, { downloaded: number; uploaded: number; removed: number; onServer: number | null; withoutEmail: number }]
  /** Uloží prílohu do súboru zvoleného v dialógu (chooseSavePath). */
  'attachments.save': [{ messageId: number; index: number; path: string }, void]
  /** Uloží všetky prílohy do priečinka zvoleného v dialógu (chooseFolder). Vráti názvy uložených súborov. */
  'attachments.saveAll': [{ messageId: number; dir: string }, { saved: string[] }]
  /** Pripraví prílohu na otvorenie (dočasný súbor). Spustiteľné súbory odmietne. */
  'attachments.prepareOpen': [{ messageId: number; index: number }, { path: string }]
  /** Náhľad prílohy v Doare: obrázok (data: URI), text, alebo PDF (dočasná kópia na zobrazenie v okne náhľadu). */
  'attachments.preview': [{ messageId: number; index: number }, AttachmentPreview]
  /** Uloží koncept lokálne a naplánuje nahratie na server. Prílohy vráti ako uložené (kind 'blob') v rovnakom poradí. */
  'drafts.save': [DraftSaveInput, { draftId: number; attachments: ComposeAttachment[] }]
  /** Zahodí koncept (aj kópiu na serveri). */
  'drafts.discard': [{ draftId: number }, void]
  /** Uložený koncept nahrať na server hneď (zatvorenie okna). */
  'drafts.flush': [{ draftId: number }, void]
  /** Vyhľadávanie (rozsah: priečinok, konto, alebo všetko). Neplatný/prázdny dotaz → prázdny výsledok. */
  'messages.search': [SearchInput & { offset: number; limit: number }, { total: number; items: MessageListItem[]; notDownloaded: number }]
  'messages.searchIds': [SearchInput, number[]]
  'accounts.get': [{ id: number }, AccountDetails]
  'accounts.update': [{ id: number; patch: AccountPatch }, AccountSummary]
  /** Overí nové nastavenia servera (s novým alebo uloženým heslom) a len ak sú v poriadku, uloží ich. */
  'accounts.updateServer': [
    { id: number; username: string; imap: ServerSettings; smtp: ServerSettings; password?: string },
    { saved: boolean; test: ConnectionTestResult }
  ]
  /** Odstráni konto z Doaru (aj jeho lokálnu kópiu pošty). Pošta na serveri zostane. */
  'accounts.remove': [{ id: number }, void]
  'accounts.reorder': [{ ids: number[] }, void]
  'settings.get': [void, AppSettings]
  'settings.set': [Partial<AppSettings>, AppSettings]
  /** Návrhy adries pri písaní (komu ste písali, od koho ste dostali poštu). */
  'addresses.suggest': [{ query: string; limit?: number }, AddressSuggestion[]]
  /** Systém hlási pripojenie k sieti / prebudenie – skúsiť sa pripojiť hneď. */
  'sync.reconnect': [void, void]
  /** Náhľad súboru zvoleného cez chooseImportFile (záloha Doar alebo cudzí mbox). */
  'import.peek': [{ path: string }, ImportPeek]
  'import.start': [{ accountId: number; path: string; mode: ImportMode; target: ImportTarget }, { jobId: number }]
  /** Pokračovanie prerušenej obnovy (súbor sa nesmel medzitým zmeniť). */
  'import.resume': [{ jobId: number }, { jobId: number }]
  'import.cancel': [{ jobId: number }, void]
  /** Zabudnúť prerušenú obnovu (na serveri sa nič nemaže). */
  'import.discard': [{ jobId: number }, void]
  'import.state': [void, ImportState]
  /** Otvorené archívy a ich priečinky (priečinky so zápornými ID). */
  'archives.list': [void, { archives: ArchiveSummary[]; folders: FolderItem[] }]
  /** Otvorí súbor zvolený cez chooseImportFile ako archív len na čítanie. */
  'archives.open': [{ path: string }, { archiveId: number }]
  /** Zatvorí archív (zmaže len jeho zoznam v Doare, súbor zostane). */
  /** Otvorí samostatnú správu zo súboru .eml (len na čítanie, do zatvorenia aplikácie). */
  'archives.openEml': [{ path: string }, { id: number }]
  'archives.close': [{ archiveId: number }, void]
  /** Prihlásenie cez Microsoft/Google: adresa pre prehliadač (otvorí ju rozhranie cez openExternal). */
  /** contacts: pýtať aj prístup ku kontaktom (synchronizácia adresára). */
  'oauth.start': [{ provider: OAuthProvider; loginHint?: string; lang?: string; text?: { title: string; done: string; failed: string }; contacts?: boolean }, { flowId: string; url: string }]
  /** Počká na dokončenie prihlásenia v prehliadači (najviac 10 minút). */
  'oauth.finish': [{ flowId: string }, { email: string | null; provider: OAuthProvider }]
  'oauth.cancel': [{ flowId: string }, void]
  /** Ktorí poskytovatelia sú v tejto zostave nastavení. */
  'oauth.available': [void, Record<OAuthProvider, boolean>]
  /** Nové prihlásenie existujúceho konta (vypršané alebo zrušené prihlásenie). */
  'accounts.reauth': [{ id: number; flowId: string }, void]
  'ai.config.get': [void, AiConfig]
  'ai.config.set': [AiConfigPatch, AiConfig]
  /** Načíta zoznam modelov (zároveň overí spojenie). Bez kľúča v požiadavke použije uložený. */
  'ai.models': [{ provider: AiProvider; baseUrl?: string; key?: string }, { models: string[] }]
  /** Odošle obsah AI – len na pokyn používateľa. Výsledok je len návrh, nič sa samo neodošle. */
  'ai.run': [AiRunInput, AiRunResult]
  'ai.cancel': [{ requestId: string }, void]
}

/** Rozšírené hľadanie (formulár): text do konkrétnych polí a filtre. Dátumy RRRR-MM-DD (vrátane). */
export interface SearchFilters {
  from?: string
  to?: string
  subject?: string
  after?: string
  before?: string
  attachment?: boolean
  unread?: boolean
  flagged?: boolean
}

export interface SearchInput {
  query: string
  filters?: SearchFilters
  /** Záporné ID = priečinok archívu. */
  folderId?: number | null
  accountId?: number | null
  /** Hľadať v celom archíve (ID archívu, kladné). */
  archiveId?: number | null
}

/** Udalosti core → rozhranie. */
export interface CoreEvents {
  'sync.status': SyncStatus
  'accounts.changed': null
  'folders.changed': { accountId: number }
  'messages.changed': { folderIds: number[] }
  'outbox.changed': null
  'export.progress': ExportProgress
  'export.finished': ExportSummary
  'import.progress': ImportProgress
  'import.finished': ImportSummary
  'import.changed': null
  'archives.changed': null
  /** Adresár sa zmenil (synchronizácia, stav synchronizácie). */
  'contacts.changed': null
  'archives.progress': { archiveId: number; bytesRead: number; fileSize: number; messages: number }
  /** Priebežný text odpovede AI. */
  'ai.chunk': { requestId: string; text: string }
}

export type RequestChannel = keyof CoreRequests
export type EventChannel = keyof CoreEvents
export type RequestInput<C extends RequestChannel> = CoreRequests[C][0]
export type RequestOutput<C extends RequestChannel> = CoreRequests[C][1]

export const REQUEST_CHANNELS = [
  'app.info',
  'accounts.list',
  'accounts.discover',
  'accounts.test',
  'accounts.add',
  'folders.list',
  'messages.list',
  'messages.thread',
  'messages.get',
  'messages.setFlags',
  'messages.markFolderRead',
  'messages.item',
  'messages.saveEml',
  'sync.now',
  'sync.status',
  'compose.prepare',
  'compose.send',
  'outbox.list',
  'outbox.resolve',
  'outbox.scheduled',
  'rules.list',
  'rules.save',
  'rules.delete',
  'rules.reorder',
  'rules.run',
  'signatures.save',
  'signatures.delete',
  'signatures.setDefault',
  'signatures.readImage',
  'templates.list',
  'templates.save',
  'templates.delete',
  'export.start',
  'export.cancel',
  'export.state',
  'messages.move',
  'messages.deleteForever',
  'messages.undo',
  'messages.listIds',
  'folders.create',
  'folders.delete',
  'folders.rename',
  'contacts.list',
  'contacts.groups',
  'contacts.groupSave',
  'contacts.groupDelete',
  'contacts.groupMembers',
  'contacts.groupAddresses',
  'contacts.fromMail',
  'contacts.save',
  'contacts.delete',
  'contacts.addFromMail',
  'contacts.import',
  'contacts.export',
  'contacts.syncStatus',
  'contacts.syncEnable',
  'contacts.syncDisable',
  'contacts.syncNow',
  'messages.unsubscribe',
  'attachments.save',
  'attachments.saveAll',
  'attachments.prepareOpen',
  'attachments.preview',
  'drafts.save',
  'drafts.discard',
  'drafts.flush',
  'messages.search',
  'messages.searchIds',
  'accounts.get',
  'accounts.update',
  'accounts.updateServer',
  'accounts.remove',
  'accounts.reorder',
  'settings.get',
  'settings.set',
  'addresses.suggest',
  'sync.reconnect',
  'import.peek',
  'import.start',
  'import.resume',
  'import.cancel',
  'import.discard',
  'import.state',
  'archives.list',
  'archives.open',
  'archives.close',
  'archives.openEml',
  'oauth.start',
  'oauth.finish',
  'oauth.cancel',
  'oauth.available',
  'accounts.reauth',
  'ai.config.get',
  'ai.config.set',
  'ai.models',
  'ai.run',
  'ai.cancel'
] as const satisfies readonly RequestChannel[]

export function isRequestChannel(ch: unknown): ch is RequestChannel {
  return typeof ch === 'string' && (REQUEST_CHANNELS as readonly string[]).includes(ch)
}

/** Správy na MessagePort. */
export type PortMessage =
  | { kind: 'req'; id: number; ch: RequestChannel; data: unknown }
  | { kind: 'res'; id: number; ok: true; data: unknown }
  | { kind: 'res'; id: number; ok: false; error: { code: string; message: string } }
  | { kind: 'evt'; ch: EventChannel; data: unknown }

/** Jazyky rozhrania. Hebrejčina sa píše sprava doľava (RTL_LOCALES). */
export const UI_LOCALES = ['sk', 'en', 'cs', 'de', 'hu', 'fr', 'es', 'ru', 'he'] as const
export type UiLocale = (typeof UI_LOCALES)[number]
/** Názvy jazykov v danom jazyku (v ponuke ich nájde aj ten, kto jazyku rozhrania nerozumie). */
export const LOCALE_NAMES: Record<UiLocale, string> = { sk: 'Slovenčina', en: 'English', cs: 'Čeština', de: 'Deutsch', hu: 'Magyar', fr: 'Français', es: 'Español', ru: 'Русский', he: 'עברית' }
export const RTL_LOCALES: readonly UiLocale[] = ['he']

export function isUiLocale(v: unknown): v is UiLocale {
  return typeof v === 'string' && (UI_LOCALES as readonly string[]).includes(v)
}

/** Jazyk systému (napr. „cs-CZ“, „iw“) → jazyk rozhrania; neznámy → angličtina. */
export function pickUiLocale(requested: string | null | undefined): UiLocale {
  let base = String(requested ?? '').toLowerCase().split(/[-_]/)[0] ?? ''
  if (base === 'iw') base = 'he'
  return isUiLocale(base) ? base : 'en'
}

/** Stav aktualizácií (spravuje main proces). */
export interface UpdateState {
  phase: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'ready' | 'error'
  /** Bežiaca verzia. */
  current: string
  /** Ponúkaná verzia (available/downloading/installing/ready). */
  version: string | null
  notes: string
  pageUrl: string | null
  sizeBytes: number
  /** 0–1 pri sťahovaní a rozbaľovaní. */
  progress: number
  error: string | null
  /** Kontrolu spustil používateľ (rozhranie ukáže aj „máte najnovšiu verziu“). */
  manual: boolean
  /** Automatická kontrola (raz za čas). */
  auto: boolean
  /** Inštalovať sa dá len v zabalenej verzii na Windowse (nie pri vývoji). */
  canInstall: boolean
  lastCheck: string | null
}

/** API sprístupnené rozhraniu cez preload (window.doar). */
export interface DoarApi {
  invoke<C extends RequestChannel>(ch: C, data?: RequestInput<C>): Promise<RequestOutput<C>>
  on<E extends EventChannel>(ch: E, fn: (data: CoreEvents[E]) => void): () => void
  /** Jazyk systému. */
  locale: string
  /** Oznámi hlavnému procesu jazyk rozhrania (menu). */
  setUiLocale(locale: UiLocale): void
  /** Oznámi hlavnému procesu zvolený vzhľad (titulok okna, posuvníky, ostatné okná). */
  setTheme(theme: 'system' | 'light' | 'dark'): void
  /** Okno „O programe“ (z ponuky ☰). */
  showAbout(): void
  /** Akcie z aplikačného menu (napr. 'add-account'). */
  onMenuAction(fn: (action: string) => void): () => void
  /** Otvorí odkaz (http, https, mailto) v systémovom prehliadači / poštovom programe. */
  openExternal(url: string): void
  /** Otvorí okno na písanie správy. */
  /** to: adresát novej správy (napr. z adresára). */
  openCompose(mode: ComposeMode, messageId?: number, to?: string): void
  /** Otvorí správu v samostatnom okne. */
  openMessage(id: number): void
  /** Otvorí náhľad PDF prílohy (dočasná kópia z attachments.preview) v okne so vstavaným prehliadačom PDF. */
  previewPdf(path: string, title: string): Promise<boolean>
  /** Uloží pripravený dokument (správu) ako PDF – súbor vyberie používateľ. Vráti true po uložení. */
  savePdf(html: string, title: string): Promise<boolean>
  /** Zavrie aktuálne okno (okno správy po odoslaní alebo po potvrdení zahodenia). */
  closeWindow(): void
  /** Hlavný proces žiada zavretie okna – rozhranie sa môže opýtať na neuložený text. */
  onCloseRequest(fn: () => void): () => void
  /** Natívny dialóg „Uložiť ako“ pre zálohu. Vráti zvolenú cestu (povolenú pre export), alebo null. */
  chooseExportFile(defaultName: string): Promise<string | null>
  /** Dialóg „Otvoriť“ pre súbor zálohy na obnovu. Vráti cestu (povolenú na čítanie), alebo null. */
  chooseImportFile(): Promise<string | null>
  /** Výber priečinka s poštou (Outlook Express, Windows Mail) na import. */
  chooseImportFolder(): Promise<string | null>
  /** Vytvorí znova odkaz na ploche a v ponuke Štart (len zostava pre Windows). */
  recreateShortcuts(): Promise<boolean>
  /** Skopíruje text do schránky. */
  copyText(text: string): void
  /** Súbory s kontaktmi (vCard, CSV) pre import do adresára. */
  chooseContactsFiles(): Promise<string[]>
  /** Ukáže súbor zálohy v Prieskumníkovi (len súbor zvolený cez chooseExportFile). */
  showInFolder(path: string): void
  /** Dialóg „Priložiť súbory“ – vybrané súbory smie jadro čítať. */
  chooseAttachFiles(): Promise<PickedFile[]>
  /** Súbory pretiahnuté do okna (objekty File z udalosti drop) – smie ich čítať jadro. */
  filesFromDrop(files: File[]): Promise<PickedFile[]>
  /** Dialóg „Uložiť ako“ pre prílohu. Vráti cestu (povolenú na zápis), alebo null. */
  chooseSavePath(defaultName: string): Promise<string | null>
  /** Dialóg výberu priečinka (Uložiť všetky prílohy). */
  chooseFolder(): Promise<string | null>
  /** Otvorí dočasný súbor prílohy v predvolenom programe (len súbory pripravené jadrom, nikdy spustiteľné). */
  openAttachmentFile(path: string): Promise<boolean>
  /**
   * Okno správy oznámi, ktorý koncept upravuje. Ak ho už upravuje iné okno, vráti false
   * (to okno sa zobrazí navrchu a toto sa má zavrieť).
   */
  claimDraft(draftId: number): Promise<boolean>
  /** Počet neprečítaných v doručenej pošte – odznak na ikone aplikácie. */
  setUnreadCount(n: number): void
  /** Vytlačí pripravený dokument (správu) cez systémový dialóg tlače. */
  printHtml(html: string, title: string): void
  /** Aktualizácie (GitHub Releases): stav, kontrola, stiahnutie, reštart do novej verzie. */
  updateState(): Promise<UpdateState>
  updateCheck(): void
  updateDownload(): void
  updateCancel(): void
  updateRestart(): void
  updateSetAuto(on: boolean): void
  updateOpenPage(): void
  onUpdateState(fn: (s: UpdateState) => void): () => void
}

/** Správy core ↔ main (tajomstvá a pod.). Rozhranie k nim nemá prístup. */
export type CoreToMain =
  | { kind: 'secret.get'; id: number; key: string }
  | { kind: 'secret.set'; id: number; key: string; value: string }
  | { kind: 'secret.delete'; id: number; key: string }
  | { kind: 'secret.status'; id: number }
  | { kind: 'ready' }
  /** Jadro sa nedokázalo spustiť (DB_TOO_NEW = databáza z novšej verzie Doar Mail) – main to povie a nereštartuje ho. */
  | { kind: 'fatal'; code: 'DB_TOO_NEW' | 'INIT_FAILED' }
  /** Nová pošta v doručenej pošte (main ukáže systémové oznámenie). Bez obsahu, ak to používateľ vypol. */
  | { kind: 'newMail'; accountEmail: string; count: number; messageId: number; from: string | null; subject: string | null }

export type MainToCore =
  | { kind: 'init'; dataDir: string; appVersion: string }
  /** Používateľ zvolil v natívnom dialógu súbor zálohy – jadro smie zapisovať len do takto povolených ciest. */
  | { kind: 'export.allow'; path: string }
  /** Súbor/priečinok zvolený používateľom v natívnom dialógu (alebo pretiahnutý) – jadro s ním smie pracovať. */
  | { kind: 'files.allow'; path: string; mode: 'read' | 'write' | 'dir' | 'tree' }
  /** Počítač sa prebudil / odomkol – skúsiť sa pripojiť hneď. */
  | { kind: 'reconnect' }
  | { kind: 'secret.result'; id: number; ok: boolean; value?: string | null; error?: string }
