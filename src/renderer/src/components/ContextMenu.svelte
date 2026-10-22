<script lang="ts">
  import { tick } from 'svelte'
  import { ui, type MenuItem } from '../lib/actions.svelte'

  let el: HTMLDivElement | undefined = $state()
  let pos = $state({ x: 0, y: 0 })
  let returnFocus: HTMLElement | null = null

  // Otvorenie: umiestniť tak, aby ponuka nevyšla z okna, a dať fokus prvej položke.
  $effect(() => {
    const m = ui.menu
    if (!m) return
    returnFocus = document.activeElement as HTMLElement | null
    pos = { x: m.x, y: m.y }
    void tick().then(() => {
      if (!el) return
      const r = el.getBoundingClientRect()
      pos = {
        x: Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4)),
        y: Math.max(4, Math.min(m.y, window.innerHeight - r.height - 4))
      }
      buttons()[0]?.focus()
    })
  })

  function buttons(): HTMLButtonElement[] {
    return [...(el?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  }

  function close(restore = true): void {
    ui.menu = null
    if (restore) returnFocus?.focus()
  }

  function run(item: MenuItem): void {
    close()
    item.run()
  }

  function onKey(e: KeyboardEvent): void {
    const list = buttons()
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      list[(i + d + list.length) % list.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      ;(e.key === 'Home' ? list[0] : list.at(-1))?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      close()
    }
  }
</script>

<svelte:window
  onpointerdown={(e) => {
    if (ui.menu && el && !el.contains(e.target as Node)) close(false)
  }}
  onblur={() => ui.menu && close(false)}
  onresize={() => ui.menu && close(false)}
/>

{#if ui.menu}
  <div class="menu" bind:this={el} role="menu" aria-label={ui.menu.label} tabindex="-1" style:left={`${pos.x}px`} style:top={`${pos.y}px`} onkeydown={onKey}>
    {#each ui.menu.items as item, i (i)}
      {#if item === 'sep'}
        <div class="sep" role="separator"></div>
      {:else}
        <button role="menuitem" class:danger={item.danger} disabled={item.disabled} onclick={() => run(item)}>
          <span class="label">{item.label}</span>
          {#if item.shortcut}<span class="kbd">{item.shortcut}</span>{/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 60;
    min-width: 230px;
    padding: 0.3rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 28px rgb(0 0 0 / 22%);
    outline: none;
  }
  button {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    width: 100%;
    padding: 0.35rem 0.7rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
    cursor: pointer;
    color: var(--text);
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--accent-soft);
    outline: none;
  }
  button:disabled {
    color: var(--text-muted);
    opacity: 0.6;
    cursor: default;
  }
  .danger {
    color: var(--danger);
  }
  .label {
    flex: 1;
  }
  .kbd {
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .sep {
    height: 1px;
    margin: 0.3rem 0.4rem;
    background: var(--border);
  }
</style>
