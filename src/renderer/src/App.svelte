<script lang="ts">
  import { onMount } from 'svelte'
  import type { AppInfo } from '../../shared/ipc'
  import { t, i18n, type MessageKey } from './i18n/index.svelte'
  import { mail, loadAccounts, loadFolders, refreshList, selectFolder, affectsCurrent } from './lib/mail.svelte'
  import { timeOnly } from './lib/format'
  import Welcome from './components/Welcome.svelte'
  import AccountWizard from './components/AccountWizard.svelte'
  import MainShell from './components/MainShell.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import BackupDialog from './components/BackupDialog.svelte'
  import { backup, initBackupEvents } from './lib/backup.svelte'

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
      }),
      initBackupEvents(),
      window.doar.on('accounts.changed', () => void loadAccounts().then(() => scheduleRefresh([], true))),
      window.doar.on('folders.changed', () => scheduleRefresh()),
      window.doar.on('messages.changed', (d) => scheduleRefresh(d.folderIds)),
      window.doar.on('sync.status', (s) => (mail.statuses[s.accountId] = s))
    ]
    return () => offs.forEach((off) => off())
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
    const list = Object.values(mail.statuses)
    const email = (id: number): string => mail.accounts.find((a) => a.id === id)?.email ?? ''
    const bad = list.find((s) => s.state === 'error')
    if (bad) return { text: t('status.failed', { account: email(bad.accountId), error: errorText(bad.code) }), tone: 'error' }
    const off = list.find((s) => s.state === 'offline')
    if (off) return { text: t('status.offline', { account: email(off.accountId) }), tone: 'warn' }
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
  <StatusBar text={status.text} tone={status.tone} onclick={backup.progress ? () => (backup.open = true) : undefined} />
</div>
<BackupDialog />

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
