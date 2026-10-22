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
  { version: 9, name: 'moving', sql: m009 }
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
