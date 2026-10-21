/**
 * Kontrakt komunikácie rozhranie ↔ core.
 * Každý kanál je tu vymenovaný; core odmietne všetko, čo tu nie je.
 */

export interface AccountSummary {
  id: number
  email: string
  name: string
  color: string
}

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

export interface DiscoveryResult {
  /** Navrhnuté nastavenia; pri `source = 'none'` len predvyplnený návrh na ručnú úpravu. */
  settings: AccountSettings
  source: DiscoverySource
  /** Poskytovateľ vyžaduje prihlásenie, ktoré zatiaľ nepodporujeme (napr. OAuth Microsoft). */
  unsupportedAuth: 'oauth2' | null
  /** Poskytovateľ vyžaduje heslo aplikácie (napr. Gmail). */
  needsAppPassword: boolean
}

/** Kódy chýb pri overovaní spojenia – rozhranie ich prekladá do zrozumiteľných viet. */
export type ConnectionErrorCode =
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
  password: string
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
}

export interface Address {
  name: string
  address: string
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
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error'

export interface SyncStatus {
  accountId: number
  state: SyncState
  /** Kód chyby (AUTH_FAILED, PASSWORD_REQUIRED, …) pri state = error/offline. */
  code?: string
  /** Priebeh sťahovania originálov. */
  pendingBodies: number
  lastSync: string | null
}

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
}

export type ComposeMode = 'new' | 'reply' | 'replyAll'

export interface ComposePrefill {
  accountId: number
  to: Address[]
  cc: Address[]
  subject: string
  /** Údaje pôvodnej správy pre citáciu (text zostaví rozhranie v jazyku používateľa). */
  quote: { from: Address[]; date: string | null; text: string } | null
  replyToMessage: number | null
}

export interface ComposeSendInput {
  accountId: number
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  replyToMessage: number | null
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

/** Požiadavky (invoke): kanál → [vstup, výstup]. */
export interface CoreRequests {
  'app.info': [void, AppInfo]
  'accounts.list': [void, AccountSummary[]]
  'accounts.discover': [{ email: string; displayName: string }, DiscoveryResult]
  'accounts.test': [{ settings: AccountSettings; password: string }, ConnectionTestResult]
  'accounts.add': [AddAccountInput, AccountSummary]
  'folders.list': [void, FolderItem[]]
  'messages.list': [{ folderId: number | null; offset: number; limit: number }, { total: number; items: MessageListItem[] }]
  'messages.get': [{ id: number; showRemote?: boolean; alwaysForSender?: boolean }, MessageView]
  'messages.setFlags': [{ ids: number[]; seen?: boolean; flagged?: boolean }, void]
  'sync.now': [{ accountId?: number }, void]
  'sync.status': [void, SyncStatus[]]
  'compose.prepare': [{ mode: ComposeMode; messageId?: number }, ComposePrefill]
  'compose.send': [ComposeSendInput, { outboxId: number }]
  'outbox.list': [void, OutboxItem[]]
  'outbox.resolve': [{ id: number; action: 'resend' | 'discard' }, void]
  'export.start': [{ accountId: number; path: string }, { jobId: number }]
  'export.cancel': [{ jobId: number }, void]
  'export.state': [void, ExportState]
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
  'messages.get',
  'messages.setFlags',
  'sync.now',
  'sync.status',
  'compose.prepare',
  'compose.send',
  'outbox.list',
  'outbox.resolve',
  'export.start',
  'export.cancel',
  'export.state'
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

export type UiLocale = 'sk' | 'en'

/** API sprístupnené rozhraniu cez preload (window.doar). */
export interface DoarApi {
  invoke<C extends RequestChannel>(ch: C, data?: RequestInput<C>): Promise<RequestOutput<C>>
  on<E extends EventChannel>(ch: E, fn: (data: CoreEvents[E]) => void): () => void
  /** Jazyk systému. */
  locale: string
  /** Oznámi hlavnému procesu jazyk rozhrania (menu). */
  setUiLocale(locale: UiLocale): void
  /** Akcie z aplikačného menu (napr. 'add-account'). */
  onMenuAction(fn: (action: string) => void): () => void
  /** Otvorí odkaz (http, https, mailto) v systémovom prehliadači / poštovom programe. */
  openExternal(url: string): void
  /** Otvorí okno na písanie správy. */
  openCompose(mode: ComposeMode, messageId?: number): void
  /** Zavrie aktuálne okno (okno správy po odoslaní alebo po potvrdení zahodenia). */
  closeWindow(): void
  /** Hlavný proces žiada zavretie okna – rozhranie sa môže opýtať na neuložený text. */
  onCloseRequest(fn: () => void): () => void
  /** Natívny dialóg „Uložiť ako“ pre zálohu. Vráti zvolenú cestu (povolenú pre export), alebo null. */
  chooseExportFile(defaultName: string): Promise<string | null>
  /** Ukáže súbor zálohy v Prieskumníkovi (len súbor zvolený cez chooseExportFile). */
  showInFolder(path: string): void
}

/** Správy core ↔ main (tajomstvá a pod.). Rozhranie k nim nemá prístup. */
export type CoreToMain =
  | { kind: 'secret.get'; id: number; key: string }
  | { kind: 'secret.set'; id: number; key: string; value: string }
  | { kind: 'secret.delete'; id: number; key: string }
  | { kind: 'secret.status'; id: number }
  | { kind: 'ready' }

export type MainToCore =
  | { kind: 'init'; dataDir: string; appVersion: string }
  /** Používateľ zvolil v natívnom dialógu súbor zálohy – jadro smie zapisovať len do takto povolených ciest. */
  | { kind: 'export.allow'; path: string }
  | { kind: 'secret.result'; id: number; ok: boolean; value?: string | null; error?: string }
