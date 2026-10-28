import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import m001 from './migrations/001_init'
import m002 from './migrations/002_password_storage'
import m003 from './migrations/003_sync'
import m004 from './migrations/004_outbox'
import m005 from './migrations/005_actions'
import m006 from './migrations/006_drafts'
import m007 from './migrations/007_import'
import m008 from './migrations/008_archives'
import m009 from './migrations/009_moving'
import m010 from './migrations/010_muted_colors'
import m011 from './migrations/011_account_colors'
import m012 from './migrations/012_vivid_colors'
import m013 from './migrations/013_contacts'
import m014 from './migrations/014_contact_address'
import m015 from './migrations/015_contact_sync'
import m016 from './migrations/016_contact_no_email'
import m017 from './migrations/017_rules_templates'
import m018 from './migrations/018_threads_groups_signatures'

/** Zoznam migrácií v poradí. Pridávaj len na koniec. */
export const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  { version: 1, name: 'init', sql: m001 },
  { version: 2, name: 'password_storage', sql: m002 },
  { version: 3, name: 'sync', sql: m003 },
  { version: 4, name: 'outbox', sql: m004 },
  { version: 5, name: 'actions', sql: m005 },
  { version: 6, name: 'drafts', sql: m006 },
  { version: 7, name: 'import', sql: m007 },
  { version: 8, name: 'archives', sql: m008 },
  { version: 9, name: 'moving', sql: m009 },
  { version: 10, name: 'muted_colors', sql: m010 },
  { version: 11, name: 'account_colors', sql: m011 },
  { version: 12, name: 'vivid_colors', sql: m012 },
  { version: 13, name: 'contacts', sql: m013 },
  { version: 14, name: 'contact_address', sql: m014 },
  { version: 15, name: 'contact_sync', sql: m015 },
  { version: 16, name: 'contact_no_email', sql: m016 },
  { version: 17, name: 'rules_templates', sql: m017 },
  { version: 18, name: 'threads_groups_signatures', sql: m018 }
]

export type Db = DatabaseSync

/**
 * Otvorí databázu a aplikuje chýbajúce migrácie.
 * Pred migráciou existujúcej databázy vytvorí zálohu `<súbor>.bak-v<verzia>`.
 */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const existed = file !== ':memory:' && existsSync(file)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`)

  const current = schemaVersion(db)
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
  if (current > latest) {
    // Staršia aplikácia nesmie pracovať s databázou novšej verzie (mohla by poškodiť údaje).
    db.close()
    throw new Error(`DB_TOO_NEW: databáza má verziu ${current}, aplikácia pozná najviac ${latest}`)
  }

  const pending = MIGRATIONS.filter((m) => m.version > current)
  if (pending.length === 0) return db

  if (existed && current > 0) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copyFileSync(file, `${file}.bak-v${current}`)
  }

  for (const m of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations(version, name) VALUES (?, ?)').run(m.version, m.name)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      db.close()
      throw e
    }
  }
  return db
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined
  return row?.v ?? 0
}

export function sqliteVersion(db: Db): string {
  return (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
}
