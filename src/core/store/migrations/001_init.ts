// Migrácia 001 – základná schéma. NIKDY ju neupravuj; zmeny len novou migráciou.
export default /* sql */ `
CREATE TABLE accounts (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL,
  display_name    TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT '',
  imap_host       TEXT NOT NULL,
  imap_port       INTEGER NOT NULL,
  imap_security   TEXT NOT NULL CHECK (imap_security IN ('tls','starttls')),
  smtp_host       TEXT NOT NULL,
  smtp_port       INTEGER NOT NULL,
  smtp_security   TEXT NOT NULL CHECK (smtp_security IN ('tls','starttls')),
  auth_type       TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password','oauth2')),
  username        TEXT NOT NULL,
  provider_key    TEXT,
  save_sent_copy  INTEGER NOT NULL DEFAULT 1,
  signature       TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '#3b82f6',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE folders (
  id                   INTEGER PRIMARY KEY,
  account_id           INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path                 TEXT NOT NULL,
  delimiter            TEXT,
  name                 TEXT NOT NULL,
  parent_path          TEXT,
  special_use          TEXT CHECK (special_use IN ('inbox','sent','drafts','trash','junk','archive','all','flagged','important')),
  special_use_source   TEXT CHECK (special_use_source IN ('server','name','user')),
  uidvalidity          INTEGER,
  uidnext              INTEGER,
  highestmodseq        TEXT,
  selectable           INTEGER NOT NULL DEFAULT 1,
  subscribed           INTEGER NOT NULL DEFAULT 1,
  total_count          INTEGER NOT NULL DEFAULT 0,
  synced_headers_upto  INTEGER NOT NULL DEFAULT 0,
  synced_bodies_count  INTEGER NOT NULL DEFAULT 0,
  last_sync_at         TEXT,
  UNIQUE (account_id, path)
);

CREATE TABLE messages (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id        INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid              INTEGER NOT NULL,
  blob_sha256      TEXT,
  size             INTEGER NOT NULL DEFAULT 0,
  internal_date    TEXT,
  date_header      TEXT,
  message_id       TEXT,
  in_reply_to      TEXT,
  references_hdr   TEXT,
  thread_key       TEXT,
  subject          TEXT NOT NULL DEFAULT '',
  from_addr        TEXT NOT NULL DEFAULT '',
  from_name        TEXT NOT NULL DEFAULT '',
  to_json          TEXT NOT NULL DEFAULT '[]',
  cc_json          TEXT NOT NULL DEFAULT '[]',
  bcc_json         TEXT NOT NULL DEFAULT '[]',
  snippet          TEXT NOT NULL DEFAULT '',
  has_attachments  INTEGER NOT NULL DEFAULT 0,
  seen             INTEGER NOT NULL DEFAULT 0,
  flagged          INTEGER NOT NULL DEFAULT 0,
  answered         INTEGER NOT NULL DEFAULT 0,
  draft            INTEGER NOT NULL DEFAULT 0,
  keywords_json    TEXT NOT NULL DEFAULT '[]',
  gm_msgid         TEXT,
  gm_labels_json   TEXT,
  local_state      TEXT NOT NULL DEFAULT 'synced' CHECK (local_state IN ('synced','pending','failed')),
  UNIQUE (folder_id, uid)
);
CREATE INDEX messages_folder_date ON messages(folder_id, internal_date DESC);
CREATE INDEX messages_account_date ON messages(account_id, internal_date DESC);
CREATE INDEX messages_message_id ON messages(message_id);
CREATE INDEX messages_blob ON messages(blob_sha256);

-- Fulltext bez uloženia obsahu (contentless); rowid = messages.id.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_text, to_text, body_text,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE addresses (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  use_count  INTEGER NOT NULL DEFAULT 0,
  last_used  TEXT
);

CREATE TABLE operations (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX operations_state ON operations(state, account_id);

CREATE TABLE outbox (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blob_sha256      TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('draft','queued','sending','sent','error','uncertain')),
  sent_copy_state  TEXT NOT NULL DEFAULT 'not_needed' CHECK (sent_copy_state IN ('not_needed','pending','done','failed')),
  smtp_response    TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,
  account_id     INTEGER,
  state          TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  progress_json  TEXT NOT NULL DEFAULT '{}',
  summary_json   TEXT
);

CREATE TABLE import_items (
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  mbox_offset    INTEGER NOT NULL,
  fingerprint    TEXT NOT NULL,
  target_folder  TEXT,
  state          TEXT NOT NULL DEFAULT 'pending',
  appended_uid   INTEGER,
  error          TEXT,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL
);

CREATE TABLE remote_content_allow (
  sender      TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`
