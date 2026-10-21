import type { ExportProgress, ExportSummary } from '../../../shared/ipc'

/** Stav zálohy v rozhraní – samotná záloha beží v jadre. */
export const backup = $state({
  open: false,
  progress: null as ExportProgress | null,
  summary: null as ExportSummary | null,
  /** Konto, pre ktoré sa záloha pripravuje (výber v dialógu). */
  accountId: null as number | null
})

export function initBackupEvents(): () => void {
  void window.doar.invoke('export.state').then((s) => {
    backup.progress = s.running
    if (!s.running) backup.summary = s.last
  })
  const offs = [
    window.doar.on('export.progress', (p) => {
      backup.progress = p
      backup.summary = null
    }),
    window.doar.on('export.finished', (s) => {
      backup.progress = null
      backup.summary = s
      backup.open = true // výsledok zálohy sa ukáže vždy, aj keď bežala na pozadí
    })
  ]
  return () => offs.forEach((o) => o())
}

export function defaultBackupName(email: string, now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `Doar-${email}-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.mbox`
}
