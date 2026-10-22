// Migrácia 006 – koncepty: rozpísaná správa sa ukladá lokálne (priebežne) a na server do Konceptov (s odstupom).
// message_id je stabilné naprieč verziami konceptu – podľa neho sa na serveri nájde a nahradí predošlá verzia.
export default /* sql */ `
CREATE TABLE drafts (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id        TEXT NOT NULL,
  data_json         TEXT NOT NULL,
  attachments_json  TEXT NOT NULL DEFAULT '[]',
  server_folder_id  INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  server_uid        INTEGER,
  rev               INTEGER NOT NULL DEFAULT 1,
  server_rev        INTEGER NOT NULL DEFAULT 0,
  deleted           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX drafts_message_id ON drafts(message_id);
`
