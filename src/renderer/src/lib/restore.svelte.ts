import type { ImportJobInfo, ImportProgress, ImportSummary } from '../../../shared/ipc'

/** Stav obnovy zo zálohy v rozhraní – samotná obnova beží v jadre. */
export const restore = $state({
  open: false,
  progress: null as ImportProgress | null,
  summary: null as ImportSummary | null,
  /** Prerušené obnovy, v ktorých sa dá pokračovať. */
  resumable: [] as ImportJobInfo[]
})

async function refresh(init = false): Promise<void> {
  const s = await window.doar.invoke('import.state').catch(() => null)
  if (!s) return
  restore.progress = s.running
  restore.resumable = s.resumable
  if (init && !s.running) restore.summary = s.last
}

export function initRestoreEvents(): () => void {
  void refresh(true)
  const offs = [
    window.doar.on('import.progress', (p) => {
      restore.progress = p
      restore.summary = null
    }),
    window.doar.on('import.finished', (s) => {
      restore.progress = null
      restore.summary = s
      restore.open = true // výsledok sa ukáže vždy, aj keď obnova bežala na pozadí
    }),
    window.doar.on('import.changed', () => void refresh())
  ]
  return () => offs.forEach((o) => o())
}

/** „Doar-jan@firma.sk-2026-10-01-1436.mbox“ → „Import – Doar-jan@firma.sk-2026-10-01-1436“. */
export function defaultImportFolder(fileName: string): string {
  const stem = fileName.replace(/\.(mbox|mbx)$/i, '').replace(/[/\\%*]/g, '_').trim()
  return `Import – ${stem || 'mbox'}`.slice(0, 120)
}
