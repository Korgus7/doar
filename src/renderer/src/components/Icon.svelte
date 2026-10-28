<script lang="ts" module>
  /** Čiarové ikony (24×24, farba podľa textu). Vlastné kresby, žiadna knižnica. */
  export const ICONS = {
    compose: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="m13.5 7.5 3 3"/>',
    sync: '<path d="M20 12a8 8 0 0 1-14.3 4.9"/><path d="M4 12A8 8 0 0 1 18.3 7.1"/><path d="M18.5 3v4.3h-4.3"/><path d="M5.5 21v-4.3h4.3"/>',
    settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
    inboxes: '<path d="M4 14h4.5l1.5 2.5h4l1.5-2.5H20"/><path d="M4 14 6.5 6.5h11L20 14v5H4z"/><path d="M8 3.5h8"/>',
    inbox: '<path d="M4 13h4.5l1.5 2.5h4l1.5-2.5H20"/><path d="M4 13 6.5 5h11L20 13v6H4z"/>',
    star: '<path d="m12 3.8 2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.6-5 2.6 1-5.6-4.1-3.9 5.6-.8z"/>',
    drafts: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 13h6M9 16.5h4"/>',
    sent: '<path d="M20.5 3.5 10 14"/><path d="m20.5 3.5-6.5 17-4-6.5-6.5-4z"/>',
    archive: '<rect x="3.5" y="4" width="17" height="4.5"/><path d="M5 8.5V20h14V8.5"/><path d="M10 12.5h4"/>',
    spam: '<path d="M8.3 3.5h7.4l5.3 5.3v7.4l-5.3 5.3H8.3L3 16.2V8.8z"/><path d="M12 8v4.8M12 16v.01"/>',
    trash: '<path d="M4 6.5h16"/><path d="M9.5 6.5V4h5v2.5"/><path d="M6 6.5 7 20h10l1-13.5"/><path d="M10 10.5v6M14 10.5v6"/>',
    folder: '<path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
    reply: '<path d="M10 5 4 11l6 6"/><path d="M4 11h9a7 7 0 0 1 7 7v1"/>',
    replyAll: '<path d="M11 5 5 11l6 6"/><path d="M7 5 1 11l6 6"/><path d="M5 11h8.5a7 7 0 0 1 7 7v1"/>',
    forward: '<path d="m14 5 6 6-6 6"/><path d="M20 11h-9a7 7 0 0 0-7 7v1"/>',
    ai: '<path d="M12 3.5c.5 3.8 2.7 6 6.5 6.5-3.8.5-6 2.7-6.5 6.5-.5-3.8-2.7-6-6.5-6.5 3.8-.5 6-2.7 6.5-6.5z"/><path d="M18.5 15.5c.2 1.5 1 2.3 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.2 2.3-1 2.5-2.5z"/>',
    print: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="7.5"/><path d="M7 14h10v6.5H7z"/>',
    unread: '<rect x="3.5" y="5.5" width="17" height="13"/><path d="m4 6.5 8 6 8-6"/>',
    read: '<path d="M3.5 10 12 4.5l8.5 5.5v9.5h-17z"/><path d="m4 10.5 8 5.5 8-5.5"/>',
    attachment: '<path d="m19.5 11.5-7.4 7.4a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3.1 3.1 0 0 1 4.4 4.4l-7.8 7.8a1.5 1.5 0 0 1-2.2-2.2l7-7"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    filter: '<path d="M4 5.5h16l-6.2 7.2V18l-3.6 1.8v-7.1z"/>',
    more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
    contacts: '<rect x="4.5" y="3.5" width="15" height="17"/><circle cx="12" cy="10" r="2.6"/><path d="M8 17c.6-2 2.1-3 4-3s3.4 1 4 3"/>'
  } as const
  export type IconName = keyof typeof ICONS
</script>

<script lang="ts">
  let { name, size = 16, filled = false }: { name: IconName; size?: number; filled?: boolean } = $props()
</script>

<svg
  class="icon"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill={filled ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false">{@html ICONS[name]}</svg
>

<style>
  .icon {
    flex: none;
    display: inline-block;
    vertical-align: -0.18em;
  }
</style>
