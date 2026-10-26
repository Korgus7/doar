<script lang="ts">
  import { tick } from 'svelte'
  import type { ExportFolderSummary, ExportPhase } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { backup, defaultBackupName } from '../lib/backup.svelte'
  import { fileSize, timeOnly } from '../lib/format'
  import { mail } from '../lib/mail.svelte'

  let error = $state<string | null>(null)
  let starting = $state(false)
  let dialogEl: HTMLDivElement | undefined = $state()

  const accountId = $derived(backup.accountId ?? mail.accounts[0]?.id ?? null)
  const account = $derived(mail.accounts.find((a) => a.id === accountId) ?? null)
  const view = $derived(backup.progress ? 'running' : backup.summary ? 'done' : 'setup')

  $effect(() => {
    if (backup.open) void tick().then(() => dialogEl?.querySelector<HTMLElement>('button.btn-primary, button')?.focus())
  })

  function errText(code: string | null | undefined): string {
    const key = `errors.${code ?? 'UNKNOWN'}` as MessageKey
    return t(key) !== key ? t(key) : t('errors.UNKNOWN')
  }

  async function start(): Promise<void> {
    if (!account || starting) return
    error = null
    starting = true
    try {
      const path = await window.doar.chooseExportFile(defaultBackupName(account.email))
      if (!path) return
      backup.summary = null
      await window.doar.invoke('export.start', { accountId: account.id, path })
    } catch (e) {
      error = errText((e as { code?: string }).code)
    } finally {
      starting = false
    }
  }

  function cancel(): void {
    if (backup.progress && confirm(t('backup.cancelConfirm'))) void window.doar.invoke('export.cancel', { jobId: backup.progress.jobId })
  }

  function close(): void {
    backup.open = false
    // Po prečítaní výsledku sa pri ďalšom otvorení začína odznova.
    if (!backup.progress) backup.summary = null
  }

  const SPECIAL_KEY: Record<string, string> = {
    '\\Inbox': 'inbox',
    '\\Drafts': 'drafts',
    '\\Sent': 'sent',
    '\\Archive': 'archive',
    '\\Junk': 'junk',
    '\\Trash': 'trash',
    '\\All': 'all'
  }
  const SPECIAL_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash', 'all']

  /** Názov priečinka ako v ľavom paneli (špeciálne priečinky po slovensky). */
  function folderLabel(f: ExportFolderSummary): string {
    const key = f.specialUse ? SPECIAL_KEY[f.specialUse] : undefined
    return key ? t(`folder.${key}` as MessageKey) : f.path
  }

  function sortedFolders(list: ExportFolderSummary[]): ExportFolderSummary[] {
    const rank = (f: ExportFolderSummary): number => {
      const key = f.specialUse ? SPECIAL_KEY[f.specialUse] : undefined
      return key ? SPECIAL_ORDER.indexOf(key) : SPECIAL_ORDER.length
    }
    return [...list].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, 'sk'))
  }

  const ORDER: ExportPhase[] = ['scan', 'check', 'download', 'write']
  function stepState(step: ExportPhase): 'waiting' | 'active' | 'done' {
    const p = backup.progress
    if (!p) return 'waiting'
    const cur = ORDER.indexOf(p.phase)
    const i = ORDER.indexOf(step)
    return i < cur ? 'done' : i === cur ? 'active' : 'waiting'
  }

  function stepDetail(step: ExportPhase): string {
    const p = backup.progress
    if (!p) return ''
    const st = stepState(step)
    if (st === 'waiting') return t('backup.waiting')
    if (step === 'scan') return st === 'done' ? t('backup.scanDone', { folders: p.foldersTotal, messages: p.messagesTotal }) : `${p.foldersDone} / ${p.foldersTotal || '…'}`
    if (step === 'check') return st === 'done' ? (p.missing ? t('backup.missing', { n: p.missing }) : t('backup.allLocal')) : '…'
    if (step === 'download') return st === 'done' ? t('backup.done') : `${p.downloaded} / ${p.missing}`
    return `${p.written} / ${p.messagesTotal}`
  }

  function stepRatio(step: ExportPhase): number | null {
    const p = backup.progress
    if (!p || stepState(step) !== 'active') return null
    if (step === 'download') return p.missing ? p.downloaded / p.missing : 1
    if (step === 'write') return p.messagesTotal ? p.written / p.messagesTotal : 1
    if (step === 'scan') return p.foldersTotal ? p.foldersDone / p.foldersTotal : null
    return null
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
</script>

{#if backup.open}
  <div class="overlay" role="presentation">
    <div class="dialog" bind:this={dialogEl} role="dialog" aria-modal="true" aria-labelledby="backup-title" tabindex="-1" onkeydown={onKey}>
      <h1 id="backup-title">{t('backup.title')}{account ? ` – ${account.email}` : ''}</h1>

      {#if view === 'setup'}
        {#if mail.accounts.length > 1}
          <label class="field">
            <span>{t('backup.account')}</span>
            <select value={accountId} onchange={(e) => (backup.accountId = Number((e.currentTarget as HTMLSelectElement).value))}>
              {#each mail.accounts as a (a.id)}
                <option value={a.id}>{a.email}</option>
              {/each}
            </select>
          </label>
        {/if}
        <p>{t('backup.lead')}</p>
        <ul class="notes">
          <li class="warn">⚠ {t('backup.warnPlain')}</li>
          <li>ℹ {t('backup.noEmptyFolders')}</li>
          <li>ℹ {t('backup.noSecrets')}</li>
        </ul>
        {#if error}<p class="alert error" role="alert">{error}</p>{/if}
        <div class="actions">
          <button class="btn" onclick={close}>{t('wizard.cancel')}</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" onclick={start} disabled={!account || starting}>{t('backup.start')}</button>
        </div>
      {:else if view === 'running'}
        <ol class="steps" aria-live="polite">
          {#each ORDER as step, i (step)}
            {@const st = stepState(step)}
            {@const ratio = stepRatio(step)}
            <li class={st}>
              <span class="num" aria-hidden="true">{st === 'done' ? '✓' : i + 1}</span>
              <span class="label">{t(`backup.step.${step}` as MessageKey)}</span>
              <span class="detail">{stepDetail(step)}</span>
              {#if ratio !== null}
                <progress max="1" value={ratio} aria-label={t(`backup.step.${step}` as MessageKey)}></progress>
              {/if}
            </li>
          {/each}
        </ol>
        <div class="actions">
          <button class="btn" onclick={cancel}>{t('backup.cancel')}</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" onclick={close}>{t('backup.hide')}</button>
        </div>
      {:else if backup.summary}
        {@const s = backup.summary}
        <div class="result {s.result}" role="status">
          {#if s.result === 'complete'}
            <strong>✔ {t('backup.result.complete')}</strong>
          {:else if s.result === 'incomplete'}
            <strong>⚠ {t('backup.result.incomplete')}</strong>
          {:else if s.result === 'cancelled'}
            <strong>{t('backup.result.cancelled')}</strong>
          {:else}
            <strong>✕ {t('backup.result.failed', { reason: errText(s.errorCode) })}</strong>
          {/if}
          {#if s.path}
            <div class="line">
              {t('backup.summaryLine', { messages: s.totals.exported, size: fileSize(s.sizeBytes), start: timeOnly(s.startedAt), end: timeOnly(s.finishedAt) })}
            </div>
            <div class="line path"><span>{t('backup.file')}:</span> <code>{s.path}</code></div>
          {/if}
        </div>
        {#if s.folders.length && s.result !== 'cancelled'}
          {@const showProblems = s.totals.unavailable > 0 || s.totals.failed > 0}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('backup.col.folder')}</th>
                  <th scope="col" class="n">{t('backup.col.expected')}</th>
                  <th scope="col" class="n">{t('backup.col.exported')}</th>
                  {#if showProblems}
                    <th scope="col" class="n">{t('backup.col.unavailable')}</th>
                    <th scope="col" class="n">{t('backup.col.failed')}</th>
                  {/if}
                </tr>
              </thead>
              <tbody>
                {#each sortedFolders(s.folders) as f (f.path)}
                  <tr class:problem={f.unavailable > 0 || f.failed > 0}>
                    <td title={f.path}>{folderLabel(f)}</td>
                    <td class="n">{f.expected}</td>
                    <td class="n">{f.exported}</td>
                    {#if showProblems}
                      <td class="n">{f.unavailable}</td>
                      <td class="n">{f.failed}</td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if s.totals.unavailable > 0}<p class="hint">{t('backup.unavailableHint')}</p>{/if}
          {#if s.gmail}<p class="hint">{t('backup.gmail')}</p>{/if}
        {/if}
        <div class="actions">
          {#if s.path}<button class="btn" onclick={() => window.doar.showInFolder(s.path!)}>{t('backup.openFolder')}</button>{/if}
          <span class="spacer"></span>
          <button class="btn btn-primary" onclick={close}>{t('backup.close')}</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgb(0 0 0 / 35%);
    z-index: 50;
  }
  .dialog {
    width: min(620px, 100%);
    max-height: calc(100vh - 2rem);
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem 1.6rem 1.2rem;
    box-shadow: 0 12px 40px rgb(0 0 0 / 25%);
  }
  h1 {
    margin: 0 0 0.8rem;
    font-size: 1.25rem;
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  p {
    margin: 0 0 0.8rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.8rem;
  }
  select {
    padding: 0.4em 0.55em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  .notes {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
    display: grid;
    gap: 0.35rem;
    font-size: 0.88rem;
    color: var(--text-muted);
  }
  .notes .warn {
    color: var(--text);
  }
  .steps {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
    display: grid;
    gap: 0.6rem;
  }
  .steps li {
    display: grid;
    grid-template-columns: 1.6rem 1fr auto;
    align-items: center;
    gap: 0.2rem 0.6rem;
  }
  .steps li.waiting {
    color: var(--text-muted);
  }
  .num {
    display: inline-grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    font-size: 0.8rem;
  }
  .steps li.active .num {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 700;
  }
  .steps li.done .num {
    background: var(--ok);
    border-color: var(--ok);
    color: #fff;
  }
  .detail {
    font-size: 0.85rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  progress {
    grid-column: 2 / 4;
    width: 100%;
    height: 6px;
    accent-color: var(--accent);
  }
  .result {
    padding: 0.7rem 0.9rem;
    border-radius: var(--radius);
    margin-bottom: 0.9rem;
    background: var(--surface-2);
  }
  .result.complete {
    background: color-mix(in srgb, var(--ok) 14%, var(--surface));
  }
  .result.incomplete {
    background: color-mix(in srgb, var(--warning) 16%, var(--surface));
  }
  .result.failed {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  }
  .line {
    margin-top: 0.35rem;
    font-size: 0.88rem;
  }
  .path code {
    overflow-wrap: anywhere;
  }
  .table-wrap {
    max-height: 240px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 0.6rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86rem;
  }
  th,
  td {
    padding: 0.35rem 0.6rem;
    text-align: start;
    border-bottom: 1px solid var(--border);
  }
  th {
    position: sticky;
    top: 0;
    background: var(--surface-2);
    font-weight: 600;
  }
  .n {
    text-align: end;
    font-variant-numeric: tabular-nums;
  }
  tr.problem td {
    color: var(--warning);
    font-weight: 600;
  }
  .hint {
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .alert.error {
    padding: 0.5rem 0.75rem;
    border-inline-start: 3px solid var(--danger);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .spacer {
    flex: 1;
  }
</style>
