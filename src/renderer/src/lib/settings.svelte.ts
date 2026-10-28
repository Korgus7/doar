import type { MailRuleInput } from '../../../shared/ipc'

export type SettingsTab = 'accounts' | 'general' | 'rules' | 'ai'

/** Otvorenie dialógu Nastavenia (z menu, z panela priečinkov, Ctrl+,). */
export const settingsUi = $state({
  open: false,
  tab: 'accounts' as SettingsTab,
  accountId: null as number | null,
  /** Predvyplnené nové pravidlo („Vytvoriť pravidlo“ zo správy). */
  ruleDraft: null as Partial<MailRuleInput> | null
})

export function openSettings(opts: { tab?: SettingsTab; accountId?: number | null; ruleDraft?: Partial<MailRuleInput> } = {}): void {
  settingsUi.tab = opts.tab ?? 'accounts'
  if (opts.accountId !== undefined) settingsUi.accountId = opts.accountId
  if (opts.ruleDraft) settingsUi.ruleDraft = opts.ruleDraft
  settingsUi.open = true
}
