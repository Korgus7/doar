import type { Db } from './store/db'
import type { AppSettings } from '../shared/ipc'

/** Všeobecné nastavenia aplikácie – tabuľka settings (kľúč → JSON). */
const DEFAULTS: AppSettings = { notifyNewMail: true, notifyShowContent: true, composeHtml: true, threads: false }

export function getSettings(db: Db): AppSettings {
  const out: AppSettings = { ...DEFAULTS }
  for (const r of db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[]) {
    if (!(r.key in DEFAULTS)) continue
    try {
      const v = JSON.parse(r.value_json) as unknown
      const k = r.key as keyof AppSettings
      if (typeof v === typeof DEFAULTS[k]) (out as unknown as Record<string, unknown>)[k] = v
    } catch {
      // poškodená hodnota → predvolená
    }
  }
  return out
}

export function setSettings(db: Db, patch: Partial<AppSettings>): AppSettings {
  const st = db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k in DEFAULTS && typeof v === typeof DEFAULTS[k as keyof AppSettings]) st.run(k, JSON.stringify(v))
  }
  return getSettings(db)
}
