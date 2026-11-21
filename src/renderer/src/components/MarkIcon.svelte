<script lang="ts">
  /** Krúžok stavu vybavenia: 0 bez stavu, 1 veľmi dôležité (červený), 2 dôležité (oranžový), 3 vybavené (zelený s fajkou). */
  let { mark, size = 14 }: { mark: number; size?: number } = $props()
</script>

<svg class="mark-icon m{mark}" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  {#if mark === 0}
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4" />
  {:else}
    <circle cx="8" cy="8" r="6.6" fill="currentColor" />
    {#if mark === 3}<path d="m5 8.2 2.1 2.1L11.2 6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />{/if}
  {/if}
</svg>

<style>
  .mark-icon {
    display: block;
    flex: none;
  }
  .m1 {
    color: #b5483f;
  }
  .m2 {
    color: #c98a2e;
  }
  .m3 {
    color: #4f8a5b;
  }
</style>
