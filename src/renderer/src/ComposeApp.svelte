<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { AccountSummary, Address, ComposeMode } from '../../shared/ipc'
  import { t, i18n, type MessageKey } from './i18n/index.svelte'
  import { fullDate } from './lib/format'

  let { mode, messageId }: { mode: ComposeMode; messageId?: number } = $props()

  let accounts = $state<AccountSummary[]>([])
  let accountId = $state<number | null>(null)
  let to = $state('')
  let cc = $state('')
  let bcc = $state('')
  let subject = $state('')
  let body = $state('')
  let showCc = $state(false)
  let replyToMessage = $state<number | null>(null)
  let sending = $state(false)
  let error = $state<string | null>(null)
  let ready = $state(false)
  let initial = ''
  let bodyEl: HTMLTextAreaElement | undefined = $state()
  let toEl: HTMLInputElement | undefined = $state()

  const fmt = (list: Address[]): string => list.map((a) => (a.name ? `${a.name.replace(/[",<>]/g, '')} <${a.address}>` : a.address)).join(', ')
  const snapshot = (): string => JSON.stringify([accountId, to, cc, bcc, subject, body])
  const dirty = (): boolean => ready && snapshot() !== initial

  function quoteText(q: { from: Address[]; date: string | null; text: string }): string {
    const sender = q.from[0] ? (q.from[0].name ? `${q.from[0].name} <${q.from[0].address}>` : q.from[0].address) : ''
    const header = t('compose.quoteHeader', { date: fullDate(q.date), sender }).replace(/\s{2,}/g, ' ')
    const quoted = q.text
      .replace(/\s+$/, '')
      .split('\n')
      .map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`))
      .join('\n')
    return `\n\n${header}\n${quoted}\n`
  }

  onMount(() => {
    document.documentElement.lang = i18n.locale
    void (async () => {
      try {
        accounts = await window.doar.invoke('accounts.list')
        const pre = await window.doar.invoke('compose.prepare', { mode, messageId })
        accountId = pre.accountId
        to = fmt(pre.to)
        cc = fmt(pre.cc)
        showCc = pre.cc.length > 0
        subject = pre.subject
        body = pre.quote ? quoteText(pre.quote) : ''
        replyToMessage = pre.replyToMessage
      } catch (e) {
        error = errText(e)
      }
      initial = snapshot()
      ready = true
      await tick()
      // Pri odpovedi kurzor na začiatok textu, pri novej správe do poľa Komu.
      if (mode === 'new') toEl?.focus()
      else {
        bodyEl?.focus()
        bodyEl?.setSelectionRange(0, 0)
        if (bodyEl) bodyEl.scrollTop = 0
      }
    })()
    return window.doar.onCloseRequest(() => {
      if (!dirty() || confirm(t('compose.discard'))) window.doar.closeWindow()
    })
  })

  $effect(() => {
    document.title = subject.trim() || t('compose.titleNew')
  })

  function errText(e: unknown): string {
    const err = e as { code?: string; message?: string }
    if (err.code === 'INVALID_RECIPIENTS') return t('errors.INVALID_RECIPIENTS', { list: (err.message ?? '').split(': ').slice(1).join(': ') })
    const key = `errors.${err.code}` as MessageKey
    return t(key) !== key ? t(key) : t('errors.generic', { message: err.message ?? String(e) })
  }

  async function send(): Promise<void> {
    if (sending || accountId === null) return
    error = null
    if (!to.trim() && !cc.trim() && !bcc.trim()) {
      error = t('errors.NO_RECIPIENTS')
      toEl?.focus()
      return
    }
    if (!subject.trim() && !confirm(t('compose.noSubject'))) return
    sending = true
    try {
      await window.doar.invoke('compose.send', { accountId, to, cc, bcc, subject, text: body, replyToMessage })
      // Správa je vo fronte – odošle sa hneď alebo hneď po obnovení spojenia. Okno môžeme zavrieť.
      window.doar.closeWindow()
    } catch (e) {
      error = errText(e)
      sending = false
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (!dirty() || confirm(t('compose.discard'))) window.doar.closeWindow()
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="compose">
  <header class="bar">
    <button class="btn btn-primary" onclick={send} disabled={sending || !ready} title={t('compose.shortcut')}>
      {sending ? t('compose.sending') : `${t('compose.send')} ➤`}
    </button>
    <span class="hint">{t('compose.plainOnly')}</span>
  </header>

  <form class="fields" onsubmit={(e) => (e.preventDefault(), send())}>
    <label class="row">
      <span>{t('compose.from')}</span>
      <select bind:value={accountId} disabled={sending}>
        {#each accounts as a (a.id)}
          <option value={a.id}>{a.email}</option>
        {/each}
      </select>
    </label>
    <label class="row">
      <span>{t('compose.to')}</span>
      <input bind:this={toEl} bind:value={to} type="text" autocomplete="off" spellcheck="false" placeholder={t('compose.toHint')} disabled={sending} />
    </label>
    {#if showCc}
      <label class="row">
        <span>{t('compose.cc')}</span>
        <input bind:value={cc} type="text" autocomplete="off" spellcheck="false" disabled={sending} />
      </label>
      <label class="row">
        <span>{t('compose.bcc')}</span>
        <input bind:value={bcc} type="text" autocomplete="off" spellcheck="false" disabled={sending} />
      </label>
    {:else}
      <div class="row">
        <span></span>
        <button type="button" class="link" onclick={() => (showCc = true)}>{t('compose.showCcBcc')}</button>
      </div>
    {/if}
    <label class="row">
      <span>{t('compose.subject')}</span>
      <input bind:value={subject} type="text" disabled={sending} />
    </label>
  </form>

  <textarea bind:this={bodyEl} bind:value={body} aria-label={t('compose.body')} spellcheck="true" disabled={sending}></textarea>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .compose {
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    height: 100%;
    background: var(--surface);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .hint {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .fields {
    padding: 0.4rem 1rem 0.2rem;
    border-bottom: 1px solid var(--border);
  }
  .row {
    display: grid;
    grid-template-columns: 7.5rem 1fr;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0;
  }
  .row > span {
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  input,
  select {
    padding: 0.4em 0.55em;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    width: 100%;
    min-width: 0;
  }
  .link {
    justify-self: start;
    border: 0;
    background: none;
    padding: 0.1rem 0;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.85rem;
  }
  textarea {
    width: 100%;
    height: 100%;
    resize: none;
    border: 0;
    padding: 1rem 1.1rem;
    background: var(--surface);
    font: 15px/1.55 var(--font-ui);
    outline-offset: -2px;
  }
  .error {
    margin: 0;
    padding: 0.6rem 1rem;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border-top: 2px solid var(--danger);
  }
</style>
