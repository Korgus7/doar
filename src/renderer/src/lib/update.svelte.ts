import type { UpdateState } from '../../../shared/ipc'
import { t } from '../i18n/index.svelte'
import { showToast } from './actions.svelte'

/** Stav aktualizácií v rozhraní – samotná kontrola a inštalácia beží v main procese. */
export const upd = $state({
  s: null as UpdateState | null,
  /** Verzia, ktorú používateľ odložil („Neskôr“) – banner sa pre ňu neukáže, kým nespustí kontrolu znova. */
  dismissed: null as string | null,
  showNotes: false
})

export function initUpdateEvents(): () => void {
  void window.doar.updateState().then((s) => (upd.s = s)).catch(() => {})
  return window.doar.onUpdateState((s) => {
    const prev = upd.s
    upd.s = s
    if (s.manual && prev?.phase === 'checking') {
      if (s.phase === 'none') showToast(t('update.none', { version: s.current }))
      if (s.phase === 'available') upd.dismissed = null
    }
  })
}

export function checkUpdates(): void {
  upd.dismissed = null
  window.doar.updateCheck()
}
