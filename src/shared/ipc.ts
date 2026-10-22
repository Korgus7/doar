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
  /** Podpis (čistý text), vkladá sa do nových správ a odpovedí. */
  signature: string
}

/** Podrobnosti konta pre nastavenia (bez hesla). */
export interface AccountDetails extends AccountSummary {
  username: string
  imap: ServerSettings
  smtp: ServerSettings
  saveSentCopy: boolean
  passwordStorage: 'os' | 'session'
  /** Správy tohto konta, ktoré ešte čakajú na odoslanie (pri odstránení konta by sa stratili). */
  pendingOutbox: number
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
}

export const ACCOUNT_COLORS = ['#3b82f6', '#e8590c', '#2f9e44', '#ae3ec9', '#0c8599', '#e03131', '#f08c00', '#5c7cfa'] as const

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
  'messages.move': [{ ids: number[]; folderId?: number; special?: 'trash' | 'archive' | 'junk' | 'inbox' }, { undo: number[]; count: number }]
  'messages.deleteForever': [{ ids: number[] }, void]
  'messages.undo': [{ undo: number[] }, { undone: boolean }]
  'messages.listIds': [{ folderId: number | null }, number[]]
  'folders.create': [{ accountId: number; parentId: number | null; name: string }, { folderId: number }]
  /** Uloží prílohu do súboru zvoleného v dialógu (chooseSavePath). */
  'attachments.save': [{ messageId: number; index: number; path: string }, void]
  /** Uloží všetky prílohy do priečinka zvoleného v dialógu (chooseFolder). Vráti názvy uložených súborov. */
  'attachments.saveAll': [{ messageId: number; dir: string }, { saved: string[] }]
  /** Pripraví prílohu na otvorenie (dočasný súbor). Spustiteľné súbory odmietne. */
  'attachments.prepareOpen': [{ messageId: number; index: number }, { path: string }]
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
  'settings.get': [void, AppSettings]
  'settings.set': [Partial<AppSettings>, AppSettings]
  /** Návrhy adries pri písaní (komu ste písali, od koho ste dostali poštu). */
  'addresses.suggest': [{ query: string; limit?: number }, Address[]]
}

export interface SearchInput {
  query: string
  folderId?: number | null
  accountId?: number | null
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
  'export.state',
  'messages.move',
  'messages.deleteForever',
  'messages.undo',
  'messages.listIds',
  'folders.create',
  'attachments.save',
  'attachments.saveAll',
  'attachments.prepareOpen',
  'drafts.save',
  'drafts.discard',
  'drafts.flush',
  'messages.search',
  'messages.searchIds',
  'accounts.get',
  'accounts.update',
  'accounts.updateServer',
  'accounts.remove',
  'settings.get',
  'settings.set',
  'addresses.suggest'
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
}

/** Správy core ↔ main (tajomstvá a pod.). Rozhranie k nim nemá prístup. */
export type CoreToMain =
  | { kind: 'secret.get'; id: number; key: string }
  | { kind: 'secret.set'; id: number; key: string; value: string }
  | { kind: 'secret.delete'; id: number; key: string }
  | { kind: 'secret.status'; id: number }
  | { kind: 'ready' }
  /** Nová pošta v doručenej pošte (main ukáže systémové oznámenie). Bez obsahu, ak to používateľ vypol. */
  | { kind: 'newMail'; accountEmail: string; count: number; messageId: number; from: string | null; subject: string | null }

export type MainToCore =
  | { kind: 'init'; dataDir: string; appVersion: string }
  /** Používateľ zvolil v natívnom dialógu súbor zálohy – jadro smie zapisovať len do takto povolených ciest. */
  | { kind: 'export.allow'; path: string }
  /** Súbor/priečinok zvolený používateľom v natívnom dialógu (alebo pretiahnutý) – jadro s ním smie pracovať. */
  | { kind: 'files.allow'; path: string; mode: 'read' | 'write' | 'dir' }
  | { kind: 'secret.result'; id: number; ok: boolean; value?: string | null; error?: string }
