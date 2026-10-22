// Migrácia 008 – lokálny archív: súbor mbox otvorený len na čítanie. Pôvodný súbor sa nemení;
// v databáze je len zoznam správ (pozícia v súbore) a fulltext. Zatvorenie archívu zmaže len tieto riadky.
export default /* sql */ `
CREATE TABLE archives (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  size           INTEGER NOT NULL DEFAULT 0,
  mtime_ms       INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'indexing',
  message_count  INTEGER NOT NULL DEFAULT 0,
  doar           INTEGER NOT NULL DEFAULT 0,
  source         TEXT,
  error          TEXT,
  added_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE archive_folders (
  id           INTEGER PRIMARY KEY,
  archive_id   INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  special_use  TEXT,
  total        INTEGER NOT NULL DEFAULT 0,
  unread       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (archive_id, key)
);

CREATE TABLE archive_messages (
  id               INTEGER PRIMARY KEY,
  archive_id       INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  folder_id        INTEGER NOT NULL REFERENCES archive_folders(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  mbox_offset      INTEGER NOT NULL,
  mbox_length      INTEGER NOT NULL,
  fingerprint      TEXT NOT NULL,
  subject          TEXT NOT NULL DEFAULT '',
  from_name        TEXT NOT NULL DEFAULT '',
  from_addr        TEXT NOT NULL DEFAULT '',
  to_json          TEXT NOT NULL DEFAULT '[]',
  date             TEXT,
  seen             INTEGER NOT NULL DEFAULT 0,
  flagged          INTEGER NOT NULL DEFAULT 0,
  answered         INTEGER NOT NULL DEFAULT 0,
  has_attachments  INTEGER NOT NULL DEFAULT 0,
  snippet          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX archive_messages_folder ON archive_messages(folder_id, date);
CREATE INDEX archive_messages_archive ON archive_messages(archive_id, date);

CREATE VIRTUAL TABLE archive_fts USING fts5(
  subject, from_text, to_text, body_text,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
`
