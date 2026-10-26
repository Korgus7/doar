<script lang="ts">
  import { tick } from 'svelte'
  import type { FolderItem, ImportFolderSummary, ImportMode, ImportPeek, ImportPhase, ImportTarget } from '../../../shared/ipc'
  import { t, type MessageKey } from '../i18n/index.svelte'
  import { restore, defaultImportFolder } from '../lib/restore.svelte'
  import { fileSize, timeOnly } from '../lib/format'
  import { mail } from '../lib/mail.svelte'
  import { folderLabel } from '../lib/actions.svelte'

  let error = $state<string | null>(null)
  let busy = $state(false)
  let dialogEl: HTMLDivElement | undefined = $state()

  let file = $state<ImportPeek | null>(null)
  let accountId = $state<number | null>(null)
  let mode = $state<ImportMode>('restore')
  let targetKind = $state<'new' | 'existing'>('new')
  let newName = $state('')
  let existingId = $state<number | null>(null)

  const account = $derived(mail.accounts.find((a) => a.id === accountId) ?? null)
  const folders = $derived(mail.folders.filter((f: FolderItem) => f.accountId === accountId && f.selectable))
  const view = $derived(restore.progress ? 'running' : restore.summary ? 'done' : 'setup')
  const effectiveMode = $derived<ImportMode>(file?.doar ? mode : 'single')

  $effect(() => {
    if (restore.open) void tick().then(() => dialogEl?.querySelector<HTMLElement>('button.btn-primary, button')?.focus())
  })

  function errText(code: string | null | undefined): string {
    const key = `errors.${code ?? 'UNKNOWN'}` as MessageKey
    return t(key) !== key ? t(key) : t('errors.UNKNOWN')
  }

  async function chooseFile(): Promise<void> {
    error = null
    busy = true
    try {
      const path = await window.doar.chooseImportFile()
      if (!path) return
      const peek = await window.doar.invoke('import.peek', { path })
      file = peek
      newName = defaultImportFolder(peek.name)
      mode = peek.doar ? 'restore' : 'single'
      // Predvolené cieľové konto: to, z ktorého záloha pochádza (ak je v Doare), inak prvé.
      const same = peek.source ? mail.accounts.find((a) => a.email.toLowerCase() === peek.source!.toLowerCase()) : undefined
      accountId = same?.id ?? accountId ?? mail.accounts[0]?.id ?? null
      existingId = null
    } catch (e) {
      error = errText((e as { code?: string }).code)
    } finally {
      busy = false
    }
  }

  async function start(): Promise<void> {
    if (!file || !account || busy) return
    let target: ImportTarget
    if (effectiveMode === 'single' && targetKind === 'existing') {
      if (existingId === null) {
        error = t('restore.chooseFolder')
        return
      }
      target = { folderId: existingId }
    } else {
      const name = (newName.trim() || defaultImportFolder(file.name)).slice(0, 200)
      target = { newName: name }
    }
    error = null
    busy = true
    try {
      restore.summary = null
      await window.doar.invoke('import.start', { accountId: account.id, path: file.path, mode: effectiveMode, target })
      file = null
    } catch (e) {
      error = errText((e as { code?: string }).code)
    } finally {
      busy = false
    }
  }

  async function resume(jobId: number): Promise<void> {
    error = null
    busy = true
    try {
      restore.summary = null
      await window.doar.invoke('import.resume', { jobId })
    } catch (e) {
      error = errText((e as { code?: string }).code)
    } finally {
      busy = false
    }
  }

  async function discard(jobId: number): Promise<void> {
    if (!confirm(t('restore.discardConfirm'))) return
    await window.doar.invoke('import.discard', { jobId }).catch(() => {})
  }

  function cancel(): void {
    if (restore.progress && confirm(t('restore.cancelConfirm'))) void window.doar.invoke('import.cancel', { jobId: restore.progress.jobId })
  }

  function close(): void {
    restore.open = false
    if (!restore.progress) {
      restore.summary = null
      file = null
      error = null
    }
  }

  function rowLabel(f: ImportFolderSummary): string {
    return f.specialUse ? t(`folder.${f.specialUse}` as MessageKey) : f.path
  }

  const ORDER: ImportPhase[] = ['scan', 'folders', 'check', 'upload']
  function stepState(step: ImportPhase): 'waiting' | 'active' | 'done' {
    const p = restore.progress
    if (!p) return 'waiting'
    const cur = ORDER.indexOf(p.phase)
    const i = ORDER.indexOf(step)
    return i < cur ? 'done' : i === cur ? 'active' : 'waiting'
  }

  function stepDetail(step: ImportPhase): string {
    const p = restore.progress
    if (!p) return ''
    const st = stepState(step)
    if (st === 'waiting') return t('backup.waiting')
    if (step === 'scan') return st === 'done' ? t('restore.scanDone', { messages: p.messagesTotal }) : `${fileSize(p.bytesRead)} / ${fileSize(p.fileSize)}`
    if (step === 'folders') return st === 'done' ? t('backup.done') : '…'
    if (step === 'check') return st === 'done' ? t('restore.checkDone', { upload: p.toUpload - p.uploaded, duplicates: p.duplicates }) : `${p.foldersDone} / ${p.foldersTotal || '…'}`
    return `${p.uploaded} / ${p.toUpload}${p.failed ? ` · ${t('restore.failedN', { n: p.failed })}` : ''}`
  }

  function stepRatio(step: ImportPhase): number | null {
    const p = restore.progress
    if (!p || stepState(step) !== 'active') return null
    if (step === 'scan') return p.fileSize ? p.bytesRead / p.fileSize : null
    if (step === 'check') return p.foldersTotal ? p.foldersDone / p.foldersTotal : null
    if (step === 'upload') return p.toUpload ? p.uploaded / p.toUpload : 1
    return null
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
</script>

{#if restore.open}
  <div class="overlay" role="presentation">
    <div class="dialog" bind:this={dialogEl} role="dialog" aria-modal="true" aria-labelledby="restore-title" tabindex="-1" onkeydown={onKey}>
      <h1 id="restore-title">{t('restore.title')}</h1>

      {#if view === 'setup'}
        {#if restore.resumable.length}
          <section class="resume" aria-label={t('restore.unfinished')}>
            <h2>{t('restore.unfinished')}</h2>
            {#each restore.resumable as j (j.jobId)}
              <div class="job">
                <div class="info">
                  <strong>{j.fileName}</strong> → {j.email}
                  <div class="sub">
                    {#if j.totals}{t('restore.jobTotals', { done: j.totals.uploaded + j.totals.duplicate, total: j.totals.total })} · {/if}{j.errorCode ? errText(j.errorCode) : t('restore.result.cancelled')}
                  </div>
                </div>
                <button class="btn btn-primary" onclick={() => resume(j.jobId)} disabled={busy}>{t('restore.resume')}</button>
                <button class="btn" onclick={() => discard(j.jobId)} disabled={busy}>{t('restore.discard')}</button>
              </div>
            {/each}
          </section>
        {/if}

        <p>{t('restore.lead')}</p>
        <div class="file">
          <button class="btn" onclick={chooseFile} disabled={busy}>{file ? t('restore.otherFile') : t('restore.chooseFile')}</button>
          {#if file}
            <div class="fileinfo">
              <strong>{file.name}</strong> · {fileSize(file.sizeBytes)}
              <div class="sub">{file.doar ? (file.source ? t('restore.doarFrom', { email: file.source }) : t('restore.doar')) : t('restore.foreign')}</div>
            </div>
          {/if}
        </div>

        {#if file}
          <label class="field">
            <span>{t('restore.account')}</span>
            <select value={accountId} onchange={(e) => ((accountId = Number((e.currentTarget as HTMLSelectElement).value)), (existingId = null))}>
              {#each mail.accounts as a (a.id)}
                <option value={a.id}>{a.email}</option>
              {/each}
            </select>
          </label>

          <fieldset>
            <legend>{t('restore.where')}</legend>
            {#if file.doar}
              <label class="radio"><input type="radio" name="mode" value="restore" bind:group={mode} /> {t('restore.modeRestore')}</label>
            {/if}
            <label class="radio"><input type="radio" name="mode" value="single" bind:group={mode} /> {t('restore.modeSingle')}</label>
            {#if effectiveMode === 'single'}
              <div class="target">
                <label class="radio"><input type="radio" name="target" value="new" bind:group={targetKind} /> {t('restore.newFolder')}</label>
                <input class="text" aria-label={t('restore.newFolder')} bind:value={newName} disabled={targetKind !== 'new'} maxlength="200" />
                <label class="radio"><input type="radio" name="target" value="existing" bind:group={targetKind} /> {t('restore.existingFolder')}</label>
                <select aria-label={t('restore.existingFolder')} disabled={targetKind !== 'existing'} value={existingId ?? ''} onchange={(e) => (existingId = Number((e.currentTarget as HTMLSelectElement).value) || null)}>
                  <option value="">{t('restore.chooseFolder')}</option>
                  {#each folders as f (f.id)}
                    <option value={f.id}>{'  '.repeat(f.depth)}{folderLabel(f)}</option>
                  {/each}
                </select>
              </div>
            {:else}
              <p class="hint">{t('restore.restoreHint')}</p>
            {/if}
          </fieldset>
        {/if}

        <ul class="notes">
          <li>ℹ {t('restore.noOverwrite')}</li>
          <li>ℹ {t('restore.noDuplicates')}</li>
          <li>ℹ {t('backup.noEmptyFolders')}</li>
        </ul>
        {#if error}<p class="alert error" role="alert">{error}</p>{/if}
        <div class="actions">
          <button class="btn" onclick={close}>{t('wizard.cancel')}</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" onclick={start} disabled={!file || !account || busy}>{t('restore.start')}</button>
        </div>
      {:else if view === 'running'}
        {@const p = restore.progress!}
        <p class="sub">{p.fileName} → {mail.accounts.find((a) => a.id === p.accountId)?.email ?? ''}</p>
        <ol class="steps" aria-live="polite">
          {#each ORDER as step, i (step)}
            {@const st = stepState(step)}
            {@const ratio = stepRatio(step)}
            <li class={st}>
              <span class="num" aria-hidden="true">{st === 'done' ? '✓' : i + 1}</span>
              <span class="label">{t(`restore.step.${step}` as MessageKey)}</span>
              <span class="detail">{stepDetail(step)}</span>
              {#if ratio !== null}
                <progress max="1" value={ratio} aria-label={t(`restore.step.${step}` as MessageKey)}></progress>
              {/if}
            </li>
          {/each}
        </ol>
        <div class="actions">
          <button class="btn" onclick={cancel}>{t('restore.cancel')}</button>
          <span class="spacer"></span>
          <button class="btn btn-primary" onclick={close}>{t('backup.hide')}</button>
        </div>
      {:else if restore.summary}
        {@const s = restore.summary}
        <div class="result {s.result}" role="status">
          {#if s.result === 'complete'}
            <strong>✔ {t('restore.result.complete')}</strong>
          {:else if s.result === 'partial'}
            <strong>⚠ {t('restore.result.partial', { n: s.totals.failed })}</strong>
          {:else if s.result === 'cancelled'}
            <strong>{t('restore.result.cancelled')}</strong>
          {:else if s.result === 'stopped'}
            <strong>⚠ {t('restore.result.stopped', { reason: errText(s.errorCode) })}</strong>
          {:else}
            <strong>✕ {t('restore.result.failed', { reason: errText(s.errorCode) })}</strong>
          {/if}
          <div class="line">
            {t('restore.summaryLine', { file: s.fileName, email: s.email, uploaded: s.totals.uploaded, duplicate: s.totals.duplicate, start: timeOnly(s.startedAt), end: timeOnly(s.finishedAt) })}
          </div>
          {#if s.errorCode === 'OVERQUOTA'}<div class="line">{t('restore.quotaHint', { n: s.totals.pending })}</div>{/if}
          {#if s.resumable && s.errorCode !== 'OVERQUOTA' && s.totals.pending}<div class="line">{t('restore.resumeHint', { n: s.totals.pending })}</div>{/if}
        </div>
        {#if s.folders.length}
          {@const showProblems = s.totals.failed > 0 || s.totals.pending > 0}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('backup.col.folder')}</th>
                  <th scope="col" class="n">{t('restore.col.total')}</th>
                  <th scope="col" class="n">{t('restore.col.uploaded')}</th>
                  <th scope="col" class="n">{t('restore.col.duplicate')}</th>
                  {#if showProblems}
                    <th scope="col" class="n">{t('restore.col.failed')}</th>
                    <th scope="col" class="n">{t('restore.col.pending')}</th>
                  {/if}
                </tr>
              </thead>
              <tbody>
                {#each s.folders as f (f.path)}
                  <tr class:problem={f.failed > 0 || f.pending > 0}>
                    <td title={f.path}>{rowLabel(f)}</td>
                    <td class="n">{f.total}</td>
                    <td class="n">{f.uploaded}</td>
                    <td class="n">{f.duplicate}</td>
                    {#if showProblems}
                      <td class="n">{f.failed}</td>
                      <td class="n">{f.pending}</td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <ul class="notes">
          {#if s.totals.duplicate}<li>ℹ {t('restore.duplicateHint')}</li>{/if}
          {#each s.failures as f (f.code)}<li class="warn">⚠ {t('restore.failure', { n: f.count, reason: errText(f.code) })}</li>{/each}
          {#if s.changedOutside}<li class="warn">⚠ {t('restore.changedOutside', { n: s.changedOutside })}</li>{/if}
          {#if s.foreign && s.mode === 'restore'}<li>ℹ {t('restore.foreignHint', { n: s.foreign })}</li>{/if}
          {#if s.keywordsDropped}<li>ℹ {t('restore.keywordsDropped', { n: s.keywordsDropped })}</li>{/if}
          {#if s.skipped}<li>ℹ {t('restore.skipped', { n: s.skipped })}</li>{/if}
        </ul>
        {#if error}<p class="alert error" role="alert">{error}</p>{/if}
        <div class="actions">
          {#if s.resumable}<button class="btn" onclick={() => resume(s.jobId)} disabled={busy}>{t('restore.resume')}</button>{/if}
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
    width: min(640px, 100%);
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
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 0.95rem;
    font-weight: 650;
  }
  p {
    margin: 0 0 0.8rem;
  }
  .sub {
    font-size: 0.85rem;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .resume {
    padding: 0.7rem 0.9rem;
    margin-bottom: 1rem;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--warning) 14%, var(--surface));
  }
  .job {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .job + .job {
    margin-top: 0.5rem;
  }
  .job .info {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .file {
    display: flex;
    gap: 0.8rem;
    align-items: center;
    margin-bottom: 0.9rem;
  }
  .fileinfo {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.8rem;
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.6rem 0.8rem 0.7rem;
    margin: 0 0 0.9rem;
  }
  legend {
    padding: 0 0.3rem;
  }
  .radio {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    padding: 0.15rem 0;
  }
  .target {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.35rem 0.6rem;
    align-items: center;
    margin: 0.4rem 0 0;
    margin-inline-start: 1.5rem;
  }
  select,
  .text {
    padding: 0.4em 0.55em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    min-width: 0;
  }
  .hint {
    margin: 0.4rem 0 0;
    margin-inline-start: 1.5rem;
    font-size: 0.85rem;
    color: var(--text-muted);
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
  .result.partial,
  .result.stopped {
    background: color-mix(in srgb, var(--warning) 16%, var(--surface));
  }
  .result.failed {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  }
  .line {
    margin-top: 0.35rem;
    font-size: 0.88rem;
    overflow-wrap: anywhere;
  }
  .table-wrap {
    max-height: 240px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 0.7rem;
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
