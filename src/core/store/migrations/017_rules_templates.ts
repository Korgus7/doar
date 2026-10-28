// Migrácia 017 – pravidlá pre novú poštu, šablóny správ a odoslanie neskôr.
export default /* sql */ `
CREATE TABLE rules (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  -- NULL = všetky kontá (presun do priečinka vyžaduje konkrétne konto)
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  field      TEXT NOT NULL CHECK (field IN ('from','to','subject','any')),
  value      TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('move','read','flag','archive','trash')),
  folder_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE templates (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  html       TEXT,
  text       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Odoslať neskôr: správa čaká vo fronte do tohto času (UTC, ISO 8601). NULL = hneď.
ALTER TABLE outbox ADD COLUMN send_at TEXT;
`
