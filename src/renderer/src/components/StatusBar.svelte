<script lang="ts">
  let { text, tone = 'ok', onclick }: { text: string; tone?: 'ok' | 'busy' | 'warn' | 'error'; onclick?: () => void } = $props()
</script>

<footer class="status" role="status" aria-live="polite">
  <span class="dot {tone}" aria-hidden="true"></span>
  {#if onclick}
    <button class="link" {onclick}>{text}</button>
  {:else}
    <span>{text}</span>
  {/if}
</footer>

<style>
  .status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.9rem;
    font-size: 0.8rem;
    color: var(--text-muted);
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-decoration: underline dotted;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .dot.ok {
    background: var(--ok);
  }
  .dot.warn {
    background: var(--warning);
  }
  .dot.error {
    background: var(--danger);
  }
  .dot.busy {
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.busy {
      animation: none;
    }
  }
</style>
