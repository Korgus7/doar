<script lang="ts">
  import { onMount } from 'svelte'
  import { i18n, t } from './i18n/index.svelte'
  import { mail, loadAccounts, loadFolders, setSelection } from './lib/mail.svelte'
  import { isArchiveId } from '../../shared/ipc'
  import { isDraft, remove, removeForever, archive, ui } from './lib/actions.svelte'
  import Reader from './components/Reader.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import Toast from './components/Toast.svelte'
  import AttachmentPreview from './components/AttachmentPreview.svelte'

  /**
   * Samostatné okno jednej správy (dvojklik alebo Enter v zozname, otvorený súbor .eml).
   * Používa ten istý Reader ako hlavné okno – zoznam tu tvorí len táto jedna správa.
   */
  let { messageId }: { messageId: number } = $props()
  let missing = $state(false)
  let loaded = false

  async function loadItem(): Promise<void> {
    if (isArchiveId(messageId)) return
    const item = await window.doar.invoke('messages.item', { id: messageId }).catch(() => null)
    if (!item) {
      // Správu medzitým odstránili (napr. v hlavnom okne) – okno už nemá čo ukázať.
      if (loaded) window.doar.closeWindow()
      else missing = true
      return
    }
    mail.pages = { 0: [item] }
    mail.total = 1
    loaded = true
  }

  onMount(() => {
    document.documentElement.lang = i18n.locale
    void (async () => {
      await Promise.all([loadAccounts(), loadFolders()]).catch(() => {})
      await loadItem()
      if (!missing) setSelection([messageId])
    })()
    let timer: ReturnType<typeof setTimeout> | null = null
    const offs = [
      window.doar.on('messages.changed', () => {
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          void loadFolders().then(loadItem)
        }, 250)
      }),
      window.doar.on('folders.changed', () => void loadFolders())
    ]
    return () => offs.forEach((off) => off())
  })

  // Správa sa presunula alebo zmazala (Del, Archivovať…) – okno sa zavrie.
  $effect(() => {
    if (mail.selectedId !== null || !loaded) return
    const h = setTimeout(() => {
      if (mail.selectedId === null) window.doar.closeWindow()
    }, 600)
    return () => clearTimeout(h)
  })

  function onKey(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey || e.metaKey
    const id = mail.selectedId
    if (ui.menu || ui.preview) return
    if (e.key === 'Escape') {
      e.preventDefault()
      window.doar.closeWindow()
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault()
      window.dispatchEvent(new Event('doar-print'))
    } else if (id === null) {
      return
    } else if (ctrl && e.key.toLowerCase() === 'r' && !isDraft(id)) {
      e.preventDefault()
      window.doar.openCompose(e.shiftKey ? 'replyAll' : 'reply', id)
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'f' && !isDraft(id)) {
      e.preventDefault()
      window.doar.openCompose('forward', id)
    } else if (e.key === 'Delete' && !isArchiveId(id)) {
      e.preventDefault()
      if (e.shiftKey) void removeForever([id])
      else remove([id])
    } else if (!ctrl && e.key.toLowerCase() === 'e' && !isArchiveId(id)) {
      e.preventDefault()
      archive([id])
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<main class="message-window">
  {#if missing}
    <p class="missing">{t('reader.missing')}</p>
  {:else}
    <Reader standalone />
  {/if}
</main>
<ContextMenu />
<Toast />
<AttachmentPreview />

<style>
  .message-window {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .message-window :global(.reader) {
    flex: 1;
    min-height: 0;
  }
  .missing {
    margin: auto;
    color: var(--text-muted);
  }
</style>
