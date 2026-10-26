<script lang="ts">
  import { onMount } from 'svelte'
  import type { AppInfo } from '../../shared/ipc'
  import { isUiLocale } from '../../shared/ipc'
  import { t, i18n, setLocale, type Locale, type MessageKey } from './i18n/index.svelte'
  import { mail, loadAccounts, loadFolders, refreshList, selectFolder, affectsCurrent } from './lib/mail.svelte'
  import { timeOnly } from './lib/format'
  import Welcome from './components/Welcome.svelte'
  import AccountWizard from './components/AccountWizard.svelte'
  import MainShell from './components/MainShell.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import BackupDialog from './components/BackupDialog.svelte'
  import { backup, initBackupEvents } from './lib/backup.svelte'
  import ImportDialog from './components/ImportDialog.svelte'
  import { restore, initRestoreEvents } from './lib/restore.svelte'
  import { initArchiveEvents, openArchive, archivePercent } from './lib/archive.svelte'
  import { initUpdateEvents, checkUpdates } from './lib/update.svelte'
  import { loadAiConfig } from './lib/ai.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'
  import { openSettings } from './lib/settings.svelte'
  import { setSelection } from './lib/mail.svelte'

  let info = $state<AppInfo | null>(null)
  let ready = $state(false)
  let coreError = $state(false)
  let wizardOpen = $state(false)

  // Zmeny zo synchronizácie prichádzajú často – zlúčime ich. O tom, či sa týkajú zobrazeného
  // zoznamu, rozhodujeme až po načítaní priečinkov (nový priečinok ešte nemusí byť známy).
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let pendingFolders = new Set<number>()
  let forceList = false
  function scheduleRefresh(folderIds: number[] = [], force = false): void {
    for (const id of folderIds) pendingFolders.add(id)
    forceList ||= force
    if (refreshTimer) return
    refreshTimer = setTimeout(async () => {
      refreshTimer = null
      const ids = [...pendingFolders]
      const force = forceList
      pendingFolders = new Set()
      forceList = false
      await loadFolders()
      if (force || affectsCurrent(ids)) await refreshList()
    }, 250)
  }

  onMount(() => {
    document.documentElement.lang = i18n.locale
    window.doar.setUiLocale(i18n.locale)
    const timer = setTimeout(() => {
      if (!info) coreError = true
    }, 10000)
    void (async () => {
      try {
        info = await window.doar.invoke('app.info')
        await loadAccounts()
        await loadFolders()
        for (const s of await window.doar.invoke('sync.status')) mail.statuses[s.accountId] = s
        await selectFolder(null)
        coreError = false
        ready = true
      } catch {
        coreError = true
      } finally {
        clearTimeout(timer)
      }
    })()
    const offs = [
      window.doar.onMenuAction((action) => {
        if (action === 'add-account') wizardOpen = true
        else if (action === 'backup' && mail.accounts.length) backup.open = true
        else if (action === 'restore' && mail.accounts.length) ((restore.kind = 'restore'), (restore.open = true))
        else if (action === 'open-archive') void openArchive()
        else if (action === 'check-updates') checkUpdates()
        else if (action.startsWith('locale:') && isUiLocale(action.slice(7))) setLocale(action.slice(7) as Locale)
        else if (action === 'settings') openSettings({ tab: mail.accounts.length ? 'accounts' : 'general' })
        else if (action.startsWith('open-message:')) {
          // Kliknutie na oznámenie o novej pošte: doručená pošta a tá správa.
          const id = Number(action.slice('open-message:'.length))
          if (Number.isInteger(id)) void selectFolder(null).then(() => setSelection([id]))
        }
      }),
      initBackupEvents(),
      initRestoreEvents(),
      initArchiveEvents(),
      initUpdateEvents(),
      window.doar.on('accounts.changed', () => void loadAccounts().then(() => scheduleRefresh([], true))),
      window.doar.on('folders.changed', () => scheduleRefresh()),
      window.doar.on('messages.changed', (d) => scheduleRefresh(d.folderIds)),
      window.doar.on('sync.status', (s) => (mail.statuses[s.accountId] = s))
    ]
    void loadAiConfig()
    // Pripojenie k sieti → hneď skúsiť synchronizovať a odoslať, čo čaká.
    const online = (): void => void window.doar.invoke('sync.reconnect').catch(() => {})
    window.addEventListener('online', online)
    offs.push(() => window.removeEventListener('online', online))
    return () => offs.forEach((off) => off())
  })

  // Neprečítané v doručenej pošte: odznak na ikone aplikácie (počty sú pri priečinkoch, nie v názve okna).
  $effect(() => {
    const n = mail.folders.filter((f) => f.specialUse === 'inbox').reduce((s, f) => s + f.unread, 0)
    window.doar.setUnreadCount(n)
    document.title = t('app.name')
  })

  function errorText(code: string | undefined): string {
    const key = `errors.${code ?? 'UNKNOWN'}` as MessageKey
    return t(key) !== key ? t(key) : t('errors.UNKNOWN')
  }

  const status = $derived.by((): { text: string; tone: 'ok' | 'busy' | 'warn' | 'error' } => {
    if (coreError) return { text: t('status.coreError'), tone: 'error' }
    if (!info) return { text: t('status.connecting'), tone: 'busy' }
    const bp = backup.progress
    if (bp) {
      const email = mail.accounts.find((a) => a.id === bp.accountId)?.email ?? ''
      if (bp.phase === 'scan') return { text: t('backup.statusScan', { email }), tone: 'busy' }
      const done = bp.phase === 'write' ? bp.written : bp.downloaded
      const total = bp.phase === 'write' ? bp.messagesTotal : bp.missing
      return { text: t('backup.status', { email, done, total }), tone: 'busy' }
    }
    const rp = restore.progress
    if (rp) {
      const email = mail.accounts.find((a) => a.id === rp.accountId)?.email ?? ''
      if (rp.phase !== 'upload') return { text: t('restore.statusPrepare', { email }), tone: 'busy' }
      return { text: t('restore.status', { email, done: rp.uploaded, total: rp.toUpload }), tone: 'busy' }
    }
    const loading = mail.archives.find((a) => a.state === 'indexing')
    if (loading) return { text: t('archive.status', { name: loading.name, pct: archivePercent(loading) }), tone: 'busy' }
    const list = Object.values(mail.statuses)
    const email = (id: number): string => mail.accounts.find((a) => a.id === id)?.email ?? ''
    const bad = list.find((s) => s.state === 'error')
    if (bad) return { text: t('status.failed', { account: email(bad.accountId), error: errorText(bad.code) }), tone: 'error' }
    const waiting = list.reduce((n, s) => n + (s.pendingChanges ?? 0), 0)
    const off = list.find((s) => s.state === 'offline')
    if (off) {
      const base = t('status.offline', { account: email(off.accountId) })
      return { text: waiting ? `${base} · ${t('status.waiting', { n: waiting })}` : base, tone: 'warn' }
    }
    const busy = list.find((s) => s.state === 'syncing')
    if (busy) return { text: t('status.syncing', { account: email(busy.accountId) }), tone: 'busy' }
    const pending = list.reduce((n, s) => n + s.pendingBodies, 0)
    const last = list.map((s) => s.lastSync).filter(Boolean).sort().at(-1) ?? null
    if (last) {
      const base = t('status.synced', { time: timeOnly(last) })
      return { text: pending ? `${base} · ${t('status.bodies', { n: pending })}` : base, tone: pending ? 'busy' : 'ok' }
    }
    return { text: t('status.version', { version: info.version, sqlite: info.sqlite }), tone: 'ok' }
  })
</script>

<div class="app">
  <main class="content">
    {#if wizardOpen}
      <AccountWizard
        onDone={() => {
          wizardOpen = false
          void loadAccounts().then(() => scheduleRefresh([], true))
        }}
        onCancel={() => (wizardOpen = false)}
      />
    {:else if ready && mail.accounts.length > 0}
      <MainShell onAddAccount={() => (wizardOpen = true)} />
    {:else if ready || coreError}
      <Welcome onAddAccount={() => (wizardOpen = true)} />
    {/if}
  </main>
  <StatusBar text={status.text} tone={status.tone} onclick={backup.progress ? () => (backup.open = true) : restore.progress ? () => (restore.open = true) : undefined} />
</div>
<BackupDialog />
<ImportDialog />
<SettingsDialog />

<style>
  .app {
    display: grid;
    grid-template-rows: 1fr auto;
    height: 100%;
  }
  .content {
    min-height: 0;
    overflow: auto;
  }
</style>
