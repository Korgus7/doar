<script lang="ts">
  import Icon from './components/Icon.svelte'
  import { onMount, tick } from 'svelte'
  import type { AccountSummary, Address, ComposeAttachment, ComposeMode, ComposePrefill } from '../../shared/ipc'
  import { MAX_ATTACHMENTS_BYTES, WARN_ATTACHMENTS_BYTES } from '../../shared/ipc'
  import { t, i18n, type MessageKey } from './i18n/index.svelte'
  import { fileSize, fullDate, timeOnly } from './lib/format'
  import { hasFormatting, htmlIsEmpty, htmlToText, quoteHtml, textToHtml, escapeHtml } from './lib/compose-html'
  import RichEditor from './components/RichEditor.svelte'
  import AddressInput from './components/AddressInput.svelte'
  import AiPanel from './components/AiPanel.svelte'
  import TemplatesPanel from './components/TemplatesPanel.svelte'
  import type { MailTemplate, Signature } from '../../shared/ipc'
  import { ai, aiReady, loadAiConfig, type AiSource } from './lib/ai.svelte'

  interface Attached {
    key: string
    name: string
    size: number
    source: ComposeAttachment
  }

  let { mode, messageId, to: presetTo }: { mode: ComposeMode; messageId?: number; to?: string } = $props()

  let accounts = $state<AccountSummary[]>([])
  let accountId = $state<number | null>(null)
  let to = $state('')
  let cc = $state('')
  let bcc = $state('')
  let subject = $state('')
  let body = $state('')
  /** Formátovaná správa (HTML editora) alebo čistý text. */
  let format = $state<'html' | 'plain'>('html')
  let html = $state('')
  let editorRef: RichEditor | undefined = $state()
  let showCc = $state(false)
  let replyToMessage = $state<number | null>(null)
  let attachments = $state<Attached[]>([])
  let dropping = $state(false)
  let dragDepth = 0
  let sending = $state(false)
  let error = $state<string | null>(null)
  let ready = $state(false)
  /** Koncept: lokálne ID, posledný uložený stav, stav ukladania. */
  let draftId = $state<number | null>(null)
  let savedSnap = ''
  let savedAt = $state<string | null>(null)
  let saveFailed = $state(false)
  let savedOffline = $state(false)
  let saving: Promise<void> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let closing = false
  /** Panel AI (návrh odpovede, úpravy textu) – len ak je AI zapnutá v nastaveniach. */
  let aiOpen = $state(false)
  /** Panel šablón a panel „Odoslať neskôr“. */
  let templatesOpen = $state(false)
  let scheduleOpen = $state(false)
  let scheduleAt = $state('')

  /** Aktuálna správa pre uloženie šablóny (len vlastný text – bez podpisu a citácie). */
  function templateSource(): { subject: string; html: string | null; text: string } {
    if (format === 'html') {
      const own = editorRef?.ownHTML() ?? html
      return { subject, html: own, text: htmlToText(own) }
    }
    return { subject, html: null, text: body.slice(0, ownEndText(body)).replace(/\s+$/, '') }
  }

  /** Vloží šablónu: predmet len do prázdneho poľa, text do prázdnej správy alebo na miesto kurzora. */
  function applyTemplate(tpl: MailTemplate): void {
    if (!subject.trim() && tpl.subject) subject = tpl.subject
    if (format === 'html') {
      editorRef?.insertTemplate(tpl.html ?? textToHtml(tpl.text))
      return
    }
    const text = tpl.text || (tpl.html ? htmlToText(tpl.html) : '')
    const end = ownEndText(body)
    const rest = body.slice(end)
    if (!body.slice(0, end).trim()) body = rest.trim() ? `${text.replace(/\s+$/, '')}\n\n${rest}` : text
    else if (bodyEl) {
      bodyEl.focus()
      if (!document.execCommand('insertText', false, text)) {
        const a = bodyEl.selectionStart
        body = body.slice(0, a) + text + body.slice(bodyEl.selectionEnd)
      }
    }
  }

  /** Hodnota pre <input type="datetime-local"> v miestnom čase. */
  function localInput(d: Date): string {
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  }
  /** Rýchla voľba: zajtra 8:00, alebo najbližší pondelok 8:00. */
  function preset(kind: 'tomorrow' | 'monday'): string {
    const d = new Date()
    d.setHours(8, 0, 0, 0)
    if (kind === 'tomorrow') d.setDate(d.getDate() + 1)
    else d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7))
    return localInput(d)
  }
  function openSchedule(): void {
    scheduleAt ||= preset('tomorrow')
    scheduleOpen = !scheduleOpen
  }
  function scheduleSend(): void {
    const at = new Date(scheduleAt)
    if (!scheduleAt || Number.isNaN(at.getTime()) || at.getTime() <= Date.now() + 60_000) {
      error = t('compose.scheduleFuture')
      return
    }
    void send(at.toISOString())
  }

  /** Koniec vlastného textu v čistom texte: pred podpisom „-- “, citáciou (aj s hlavičkou) alebo preposlanou správou. */
  function ownEndText(s: string): number {
    const lines = s.split('\n')
    let pos = 0
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!
      if (/^-- ?$/.test(l) || /^-{5,}/.test(l)) return pos
      if (/^>/.test(l)) {
        const prev = lines[i - 1]
        return i > 0 && prev && prev.trim() ? pos - prev.length - 1 : pos
      }
      pos += l.length + 1
    }
    return s.length
  }

  /** Čo sa odošle AI: označený text, inak vlastný text správy (bez podpisu a citácie). */
  function aiSource(): AiSource | null {
    if (format === 'html') return editorRef?.aiSource() ?? null
    if (!bodyEl) return null
    const a = bodyEl.selectionStart
    const b = bodyEl.selectionEnd
    if (a !== b) return { text: body.slice(a, b), from: a, to: b, selection: true }
    const to = ownEndText(body)
    return { text: body.slice(0, to), from: 0, to, selection: false }
  }

  /** Vloží výsledok AI (Ctrl+Z vráti späť). Ak sa text medzitým zmenil, nič nevloží. */
  function aiApply(src: AiSource, text: string): boolean {
    if (format === 'html') return editorRef?.aiApply(src, text) ?? false
    if (!bodyEl || body.slice(src.from, src.to) !== src.text) return false
    const ins = !src.selection && src.to < body.length ? `${text.replace(/\s+$/, '')}\n\n` : text
    bodyEl.focus()
    bodyEl.setSelectionRange(src.from, src.to)
    // insertText zachová históriu úprav (Ctrl+Z).
    if (!document.execCommand('insertText', false, ins)) body = body.slice(0, src.from) + ins + body.slice(src.to)
    return true
  }

  /**
   * Podpis: konto môže mať viac podpisov (formátovaných, aj s logom), predvolený sa vloží do novej správy.
   * V okne sa dá vybrať iný alebo žiadny. Pri zmene odosielateľa sa vymení – ak ho používateľ v správe neupravil.
   */
  let sigId = $state<number | null>(null)
  /** Podpis, ktorý Doar naposledy vložil (na porovnanie, či ho používateľ medzitým neupravil). */
  let sigInserted: string | null = null
  let sigInsertedText = ''
  const signaturesOf = (id: number | null): Signature[] => accounts.find((a) => a.id === id)?.signatures ?? []
  const defaultSignature = (id: number | null): Signature | null => signaturesOf(id).find((x) => x.isDefault) ?? null
  const sigName = (x: Signature, i: number): string => x.name || t('signature.numbered', { n: i + 1 })
  /** Porovnanie podpisov bez ohľadu na drobné rozdiely v HTML editora. */
  const sameSig = (a: string | null, b: string | null): boolean =>
    (a === null || !a.trim()) === (b === null || !b.trim()) && (a === null || b === null || (htmlToText(a).trim() === htmlToText(b).trim() && (a.match(/<img/g)?.length ?? 0) === (b.match(/<img/g)?.length ?? 0)))
  const sigBlockHtml = (x: Signature | null): string => (x ? `<p>--</p>${x.html}` : '')
  const sigBlockText = (x: Signature | null): string => (x?.text.trim() ? `\n\n-- \n${x.text.trim()}` : '')

  /** Vloží vybraný podpis (aj žiadny) namiesto toho, ktorý je v správe. */
  function applySignature(next: Signature | null): void {
    if (format === 'html') editorRef?.setSignature(next?.html ?? null)
    else {
      const m = /(?:^|\n)(-- ?\n)/.exec(body)
      if (m) {
        // Podpis od riadku „-- “ po citáciu / preposlanú správu (aj s jej hlavičkou).
        const lineAt = m.index + (m[0].startsWith('\n') ? 1 : 0)
        const after = lineAt + m[1]!.length
        const tail = body.slice(after + ownEndText(body.slice(after))).replace(/^\s+/, '')
        body = body.slice(0, lineAt).replace(/\s+$/, '') + sigBlockText(next) + (tail ? `\n\n${tail}` : '')
      } else if (next) {
        const at = ownEndText(body)
        const tail = body.slice(at).replace(/^\s+/, '')
        body = body.slice(0, at).replace(/\s+$/, '') + sigBlockText(next) + (tail ? `\n\n${tail}` : '')
      }
    }
    sigId = next?.id ?? null
    sigInserted = next?.html ?? null
    sigInsertedText = sigBlockText(next).trim()
  }

  /** Iný odosielateľ → jeho predvolený podpis (ak používateľ podpis v správe neupravil). */
  function onAccountChange(): void {
    const untouched =
      format === 'html' ? sameSig(editorRef?.signatureHTML() ?? null, sigInserted) : sigInsertedText ? body.includes(sigInsertedText) : !/(^|\n)-- ?\n/.test(body)
    if (!untouched) return
    applySignature(defaultSignature(accountId))
  }

  /** Výber podpisu v okne správy. */
  function onSignatureSelect(value: string): void {
    const next = signaturesOf(accountId).find((x) => String(x.id) === value) ?? null
    applySignature(next)
  }

  /** Prepnutie formátovaný ↔ čistý text. */
  function toggleFormat(): void {
    if (format === 'html') {
      const cur = editorRef?.getHTML() ?? html
      if (hasFormatting(cur) && !confirm(t('compose.toPlainConfirm'))) return
      body = htmlToText(cur)
      format = 'plain'
    } else {
      html = textToHtml(body)
      format = 'html'
    }
  }

  let bodyEl: HTMLTextAreaElement | undefined = $state()
  let toEl: HTMLInputElement | undefined = $state()

  const fmt = (list: Address[]): string => list.map((a) => (a.name ? `${a.name.replace(/[",<>]/g, '')} <${a.address}>` : a.address)).join(', ')
  const snapshot = (): string => JSON.stringify([accountId, to, cc, bcc, subject, format, format === 'html' ? html : body, attachments.map((a) => a.key)])
  const totalSize = $derived(attachments.reduce((s, a) => s + a.size, 0))
  /** Je niečo, čo ešte nie je uložené v koncepte? */
  const unsaved = (): boolean => ready && snapshot() !== savedSnap
  const isEmpty = (): boolean => !to.trim() && !cc.trim() && !bcc.trim() && !subject.trim() && (format === 'html' ? htmlIsEmpty(html) : !body.trim()) && attachments.length === 0

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

  function forwardText(f: NonNullable<ComposePrefill['forward']>): string {
    const one = (a: Address): string => (a.name ? `${a.name} <${a.address}>` : a.address)
    const lines = [
      t('compose.fwdHeader'),
      `${t('compose.from')}: ${f.from.map(one).join(', ')}`,
      `${t('reader.date')}: ${fullDate(f.date)}`,
      `${t('compose.subject')}: ${f.subject}`,
      ...(f.to.length ? [`${t('compose.to')}: ${f.to.map(one).join(', ')}`] : []),
      ...(f.cc.length ? [`${t('compose.cc')}: ${f.cc.map(one).join(', ')}`] : [])
    ]
    return `\n\n${lines.join('\n')}\n\n${f.text.replace(/\s+$/, '')}\n`
  }

  function addFiles(list: { path: string; name: string; size: number }[]): void {
    const have = new Set(attachments.map((a) => a.key))
    for (const f of list) {
      const key = `file:${f.path}`
      if (have.has(key)) continue
      have.add(key)
      attachments.push({ key, name: f.name, size: f.size, source: { kind: 'file', path: f.path } })
    }
  }

  async function pickFiles(): Promise<void> {
    addFiles(await window.doar.chooseAttachFiles())
  }

  function removeAttachment(key: string): void {
    attachments = attachments.filter((a) => a.key !== key)
  }

  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
  }

  async function onDrop(e: DragEvent): Promise<void> {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    dropping = false
    if (sending) return
    const files = [...(e.dataTransfer?.files ?? [])]
    const got = await window.doar.filesFromDrop(files)
    addFiles(got)
    if (got.length < files.length) error = t('compose.dropSkipped')
  }

  function forwardHtml(f: NonNullable<ComposePrefill['forward']>): string {
    const lines = forwardText(f).trim().split('\n\n')[0]!.split('\n')
    return `<p>${lines.map(escapeHtml).join('<br>')}</p>${textToHtml(f.text.replace(/\s+$/, ''))}`
  }

  function quoteHeader(q: { from: Address[]; date: string | null }): string {
    const sender = q.from[0] ? (q.from[0].name ? `${q.from[0].name} <${q.from[0].address}>` : q.from[0].address) : ''
    return t('compose.quoteHeader', { date: fullDate(q.date), sender }).replace(/\s{2,}/g, ' ')
  }

  onMount(() => {
    document.documentElement.lang = i18n.locale
    void (async () => {
      try {
        accounts = await window.doar.invoke('accounts.list')
        void loadAiConfig()
        const settings = await window.doar.invoke('settings.get').catch(() => null)
        const pre = await window.doar.invoke('compose.prepare', { mode, messageId })
        accountId = pre.accountId
        to = pre.draft ? pre.draft.to : mode === 'new' && presetTo ? presetTo : fmt(pre.to)
        cc = pre.draft ? pre.draft.cc : fmt(pre.cc)
        bcc = pre.draft ? pre.draft.bcc : ''
        showCc = !!(cc || bcc)
        subject = pre.subject
        format = pre.draft ? (pre.draft.html ? 'html' : 'plain') : settings?.composeHtml === false ? 'plain' : 'html'
        if (format === 'html') {
          const sig = pre.draft ? null : defaultSignature(pre.accountId)
          sigId = sig?.id ?? null
          sigInserted = sig?.html ?? null
          html = pre.draft
            ? pre.draft.html!
            : `<p></p>${sigBlockHtml(sig)}${pre.quote ? quoteHtml(quoteHeader(pre.quote), pre.quote.text) : pre.forward ? forwardHtml(pre.forward) : ''}`
        } else {
          const sig = pre.draft ? null : defaultSignature(pre.accountId)
          sigId = sig?.id ?? null
          sigInserted = sig?.html ?? null
          sigInsertedText = sigBlockText(sig).trim()
          body = pre.draft ? pre.draft.text : sigBlockText(sig) + (pre.quote ? quoteText(pre.quote) : pre.forward ? forwardText(pre.forward) : '')
        }
        replyToMessage = pre.replyToMessage
        attachments = pre.attachments.map((a, i) => ({ key: `pre:${i}`, name: a.filename, size: a.size, source: a.source }))
        if (pre.draftId !== null) {
          draftId = pre.draftId
          // Ten istý koncept už upravuje iné okno → to sa zobrazí, toto sa zavrie.
          if (!(await window.doar.claimDraft(pre.draftId))) {
            closing = true
            window.doar.closeWindow()
            return
          }
        }
      } catch (e) {
        error = errText(e)
      }
      ready = true
      await tick()
      // Editor si HTML upraví do svojej podoby – porovnávať treba až s ňou.
      if (format === 'html' && editorRef) html = editorRef.getHTML()
      savedSnap = snapshot()
      // Pri odpovedi kurzor na začiatok textu, pri novej a preposielanej správe do poľa Komu.
      if (mode === 'new' || mode === 'forward') toEl?.focus()
      else if (format === 'html') editorRef?.focus('start')
      else {
        bodyEl?.focus()
        bodyEl?.setSelectionRange(0, 0)
        if (bodyEl) bodyEl.scrollTop = 0
      }
    })()
    return window.doar.onCloseRequest(() => void closeCompose())
  })

  // Priebežné ukladanie konceptu: chvíľu po poslednej zmene.
  $effect(() => {
    const snap = snapshot()
    if (!ready || sending || closing || snap === savedSnap) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveDraft(false), 1500)
  })

  async function saveDraft(flush: boolean): Promise<boolean> {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    while (saving) await saving
    if (accountId === null) return false
    const snap = snapshot()
    if (snap === savedSnap) {
      if (flush && draftId !== null) await window.doar.invoke('drafts.flush', { draftId }).catch(() => {})
      return true
    }
    const keys = attachments.map((a) => a.key)
    let ok = true
    saving = (async () => {
      try {
        const r = await window.doar.invoke('drafts.save', {
          draftId,
          accountId: accountId!,
          to,
          cc,
          bcc,
          subject,
          text: format === 'plain' ? body : htmlToText(html),
          html: format === 'html' ? html : null,
          replyToMessage,
          attachments: attachments.map((a) => ({ ...a.source })),
          flush
        })
        if (draftId === null) void window.doar.claimDraft(r.draftId)
        draftId = r.draftId
        // Prílohy sú odteraz uložené v koncepte (súbor na disku už nie je potrebný).
        r.attachments.forEach((src, i) => {
          const a = attachments.find((x) => x.key === keys[i])
          if (a) a.source = src
        })
        savedSnap = snap
        savedAt = new Date().toISOString()
        saveFailed = false
        // Bez pripojenia je koncept zatiaľ len v tomto počítači – povedať to.
        const st = await window.doar.invoke('sync.status').catch(() => [])
        savedOffline = st.some((x) => x.accountId === accountId && (x.state === 'offline' || x.state === 'error'))
      } catch (e) {
        ok = false
        saveFailed = true
        error = errText(e)
      }
    })()
    await saving
    saving = null
    return ok
  }

  /** Zatvorenie okna: rozpísaná správa sa uloží ako koncept (nič sa nestratí). Prázdny koncept sa zahodí. */
  async function closeCompose(): Promise<void> {
    if (closing) return
    closing = true
    if (saveTimer) clearTimeout(saveTimer)
    while (saving) await saving
    try {
      if (draftId !== null && isEmpty()) await window.doar.invoke('drafts.discard', { draftId })
      else if (unsaved()) {
        if (!(await saveDraft(true)) && !confirm(t('compose.closeUnsaved'))) {
          closing = false
          return
        }
      } else if (draftId !== null) await window.doar.invoke('drafts.flush', { draftId })
    } catch {
      // zatvoriť aj tak – posledná verzia je uložená lokálne
    }
    window.doar.closeWindow()
  }

  async function discard(): Promise<void> {
    if (!isEmpty() && !confirm(t('compose.discardConfirm'))) return
    closing = true
    if (saveTimer) clearTimeout(saveTimer)
    while (saving) await saving
    if (draftId !== null) await window.doar.invoke('drafts.discard', { draftId }).catch(() => {})
    window.doar.closeWindow()
  }

  $effect(() => {
    document.title = subject.trim() || t('compose.titleNew')
  })

  function errText(e: unknown): string {
    const err = e as { code?: string; message?: string }
    if (err.code === 'ATTACHMENT_MISSING') return t('errors.ATTACHMENT_MISSING', { name: (err.message ?? '').split(': ').slice(1).join(': ') })
    if (err.code === 'INVALID_RECIPIENTS') return t('errors.INVALID_RECIPIENTS', { list: (err.message ?? '').split(': ').slice(1).join(': ') })
    const key = `errors.${err.code}` as MessageKey
    return t(key) !== key ? t(key) : t('errors.generic', { message: err.message ?? String(e) })
  }

  async function send(sendAt: string | null = null): Promise<void> {
    if (sending || accountId === null) return
    error = null
    if (!to.trim() && !cc.trim() && !bcc.trim()) {
      error = t('errors.NO_RECIPIENTS')
      toEl?.focus()
      return
    }
    if (totalSize > MAX_ATTACHMENTS_BYTES) {
      error = t('errors.ATTACHMENTS_TOO_LARGE')
      return
    }
    if (!subject.trim() && !confirm(t('compose.noSubject'))) return
    sending = true
    if (saveTimer) clearTimeout(saveTimer)
    while (saving) await saving
    try {
      await window.doar.invoke('compose.send', {
        accountId,
        to,
        cc,
        bcc,
        subject,
        text: format === 'plain' ? body : htmlToText(html),
        html: format === 'html' ? html : null,
        replyToMessage,
        // Proxy zo stavu Svelte sa cez MessagePort neprenesie – posielame obyčajné objekty.
        attachments: attachments.map((a) => ({ ...a.source })),
        draftId,
        sendAt
      })
      closing = true
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
      void closeCompose()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void saveDraft(true)
    }
  }
</script>

<svelte:window
  onkeydown={onKey}
  ondragenter={(e) => {
    if (!hasFiles(e)) return
    dragDepth++
    dropping = true
  }}
  ondragleave={(e) => {
    if (!hasFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) dropping = false
  }}
  ondragover={(e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }}
  ondrop={(e) => void onDrop(e)}
/>

<div class="compose">
  <header class="bar">
    <span class="split">
      <button class="btn btn-primary" onclick={() => void send()} disabled={sending || !ready} title={t('compose.shortcut')}>
        {sending ? t('compose.sending') : `${t('compose.send')} ➤`}
      </button>
      <button class="btn btn-primary more" class:on={scheduleOpen} aria-pressed={scheduleOpen} onclick={openSchedule} disabled={sending || !ready} title={t('compose.sendLater')} aria-label={t('compose.sendLater')}>🕓</button>
    </span>
    <button class="btn" onclick={pickFiles} disabled={sending || !ready}><Icon name="attachment" size={15} />{t('compose.attach')}</button>
    <button class="btn" class:on={format === 'html'} aria-pressed={format === 'html'} onclick={toggleFormat} disabled={sending || !ready} title={t('compose.formatTitle')}>
      {format === 'html' ? t('compose.formatOn') : t('compose.formatOff')}
    </button>
    {#if aiReady(ai.config)}
      <button class="btn" class:on={aiOpen} aria-pressed={aiOpen} onclick={() => (aiOpen = !aiOpen)} disabled={sending || !ready} title={t('ai.compose.buttonTitle')}><Icon name="ai" size={15} />{t('ai.compose.button')}</button>
    {/if}
    <button class="btn" class:on={templatesOpen} aria-pressed={templatesOpen} onclick={() => (templatesOpen = !templatesOpen)} disabled={sending || !ready} title={t('templates.buttonTitle')}>{t('templates.button')}</button>
    <button class="btn" onclick={discard} disabled={sending || !ready} title={t('compose.discardTitle')}>🗑 {t('compose.discardBtn')}</button>
    <span class="status" class:warn={saveFailed} role="status">
      {#if saveFailed}{t('compose.draftFailed')}{:else if savedAt && savedOffline}{t('compose.draftSavedLocal', { time: timeOnly(savedAt) })}{:else if savedAt}{t('compose.draftSaved', { time: timeOnly(savedAt) })}{:else}{t('compose.plainOnly')}{/if}
    </span>
  </header>

  <form class="fields" onsubmit={(e) => (e.preventDefault(), send())}>
    <label class="row">
      <span>{t('compose.from')}</span>
      <select bind:value={accountId} disabled={sending} onchange={onAccountChange}>
        {#each accounts as a (a.id)}
          <option value={a.id}>{a.email}</option>
        {/each}
      </select>
    </label>
    <div class="row">
      <label for="f-to">{t('compose.to')}</label>
      <AddressInput id="f-to" label={t('compose.to')} bind:value={to} bind:inputEl={toEl} placeholder={t('compose.toHint')} disabled={sending} />
    </div>
    {#if showCc}
      <div class="row">
        <label for="f-cc">{t('compose.cc')}</label>
        <AddressInput id="f-cc" label={t('compose.cc')} bind:value={cc} disabled={sending} />
      </div>
      <div class="row">
        <label for="f-bcc">{t('compose.bcc')}</label>
        <AddressInput id="f-bcc" label={t('compose.bcc')} bind:value={bcc} disabled={sending} />
      </div>
    {:else}
      <div class="row">
        <span></span>
        <button type="button" class="link" onclick={() => (showCc = true)}>{t('compose.showCcBcc')}</button>
      </div>
    {/if}
    <label class="row">
      <span>{t('compose.subject')}</span>
      <input bind:value={subject} type="text" dir="auto" disabled={sending} />
    </label>
    {#if signaturesOf(accountId).length}
      <label class="row">
        <span>{t('signature.label')}</span>
        <select class="sig" value={sigId === null ? '' : String(sigId)} onchange={(e) => onSignatureSelect(e.currentTarget.value)} disabled={sending}>
          {#each signaturesOf(accountId) as x, i (x.id)}<option value={String(x.id)}>{sigName(x, i)}</option>{/each}
          <option value="">{t('signature.none')}</option>
        </select>
      </label>
    {/if}
  </form>

  {#if attachments.length}
    <section class="attachments" aria-label={t('compose.attachments')}>
      <ul>
        {#each attachments as a (a.key)}
          <li class="att">
            <span aria-hidden="true">📎</span>
            <span class="att-name" title={a.name}>{a.name}</span>
            <span class="size">{fileSize(a.size)}</span>
            <button type="button" class="remove" aria-label={t('compose.removeAttachment', { name: a.name })} title={t('compose.removeAttachment', { name: a.name })} disabled={sending} onclick={() => removeAttachment(a.key)}>×</button>
          </li>
        {/each}
      </ul>
      <p class="total" class:warn={totalSize > WARN_ATTACHMENTS_BYTES}>
        {t('compose.attachmentsTotal', { size: fileSize(totalSize) })}
        {#if totalSize > MAX_ATTACHMENTS_BYTES}· {t('errors.ATTACHMENTS_TOO_LARGE')}{:else if totalSize > WARN_ATTACHMENTS_BYTES}· {t('compose.attachmentsBig')}{/if}
      </p>
    </section>
  {/if}

  {#if scheduleOpen && ready}
    <form
      class="schedule"
      onsubmit={(e) => {
        e.preventDefault()
        scheduleSend()
      }}
    >
      <label for="send-at">{t('compose.sendLaterAt')}</label>
      <input id="send-at" type="datetime-local" bind:value={scheduleAt} min={localInput(new Date())} disabled={sending} />
      <button type="button" class="btn small" onclick={() => (scheduleAt = preset('tomorrow'))} disabled={sending}>{t('compose.tomorrowMorning')}</button>
      <button type="button" class="btn small" onclick={() => (scheduleAt = preset('monday'))} disabled={sending}>{t('compose.mondayMorning')}</button>
      <button type="submit" class="btn btn-primary small" disabled={sending || !scheduleAt}>{t('compose.schedule')}</button>
      <small>{t('compose.scheduleNote')}</small>
    </form>
  {/if}

  {#if templatesOpen && ready}
    <TemplatesPanel current={templateSource} apply={applyTemplate} disabled={sending} onclose={() => (templatesOpen = false)} />
  {/if}

  {#if aiOpen && ready && aiReady(ai.config)}
    <AiPanel replyTo={replyToMessage} getSource={aiSource} apply={aiApply} disabled={sending} onclose={() => (aiOpen = false)} />
  {/if}

  {#if format === 'html' && ready}
    <RichEditor bind:this={editorRef} {html} label={t('compose.body')} disabled={sending} onchange={(h) => (html = h)} />
  {:else if format === 'plain'}
    <textarea bind:this={bodyEl} bind:value={body} aria-label={t('compose.body')} spellcheck="true" dir="auto" disabled={sending}></textarea>
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if dropping}
    <div class="dropzone" aria-hidden="true"><span>📎 {t('compose.dropHere')}</span></div>
  {/if}
</div>

<style>
  .compose {
    /* Stĺpec: lišta, polia, (prílohy), text, (chyba) – text zaberie zvyšok výšky. */
    display: flex;
    flex-direction: column;
    position: relative;
    height: 100%;
    background: var(--surface);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .bar .btn {
    white-space: nowrap;
    flex: none;
  }
  .split {
    display: inline-flex;
    flex: none;
  }
  .split .btn:first-child {
    border-start-end-radius: 0;
    border-end-end-radius: 0;
  }
  .split .more {
    border-start-start-radius: 0;
    border-end-start-radius: 0;
    border-inline-start: 1px solid rgb(255 255 255 / 30%);
    padding-inline: 0.55em;
  }
  .schedule {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    font-size: 0.88rem;
  }
  .schedule input {
    width: auto;
  }
  .schedule small {
    flex-basis: 100%;
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .btn.small {
    padding: 0.25em 0.6em;
    font-size: 0.82rem;
  }
  .status {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-inline-start: auto;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .status.warn {
    color: var(--warning);
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
  .row > label,
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
  select.sig {
    justify-self: start;
    width: auto;
    min-width: 12rem;
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
    /* Každý riadok podľa svojho písma (hebrejčina sprava, slovenčina zľava). */
    unicode-bidi: plaintext;
    flex: 1;
    min-height: 0;
    width: 100%;
    resize: none;
    border: 0;
    padding: 1rem 1.1rem;
    background: var(--surface);
    font: 15px/1.55 var(--font-ui);
    /* Plocha na text je zrejmá aj bez rámika pri písaní. */
    outline: none;
    box-shadow: none;
  }
  .attachments {
    padding: 0.5rem 1rem 0.3rem;
    border-bottom: 1px solid var(--border);
    max-height: 30vh;
    overflow: auto;
  }
  .attachments ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .att {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    max-width: 20rem;
    padding-block: 0.2rem;
    padding-inline: 0.6rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: 0.88rem;
  }
  .att-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size,
  .total {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .total {
    margin: 0.35rem 0 0;
  }
  .total.warn {
    color: var(--warning);
  }
  .remove {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1.05rem;
    line-height: 1;
    padding: 0 0.3rem;
    border-radius: var(--radius-sm);
  }
  .remove:hover {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
  .dropzone {
    position: absolute;
    inset: 0.5rem;
    display: grid;
    place-items: center;
    border: 3px dashed var(--accent);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--accent) 12%, var(--surface));
    font-size: 1.2rem;
    font-weight: 600;
    pointer-events: none;
  }
  .error {
    margin: 0;
    padding: 0.6rem 1rem;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border-top: 2px solid var(--danger);
  }
</style>
