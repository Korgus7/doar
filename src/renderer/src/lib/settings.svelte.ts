/** Otvorenie dialógu Nastavenia (z menu, z panela priečinkov, Ctrl+,). */
export const settingsUi = $state({
  open: false,
  tab: 'accounts' as 'accounts' | 'general' | 'ai',
  accountId: null as number | null
})

export function openSettings(opts: { tab?: 'accounts' | 'general' | 'ai'; accountId?: number | null } = {}): void {
  settingsUi.tab = opts.tab ?? 'accounts'
  if (opts.accountId !== undefined) settingsUi.accountId = opts.accountId
  settingsUi.open = true
}
