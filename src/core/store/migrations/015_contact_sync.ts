// Migrácia 015 – synchronizácia adresára cez CardDAV (Google kontakty).
// Prepojený kontakt má adresu a ETag na serveri a pôvodný vCard (zachovajú sa aj údaje, ktoré Doar nezobrazuje).
// dirty = zmena v Doare čaká na odoslanie; zmazané prepojené kontakty čakajú v contact_tombstones.
export default /* sql */ `
ALTER TABLE contacts ADD COLUMN sync_account INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN remote_href TEXT;
ALTER TABLE contacts ADD COLUMN remote_etag TEXT;
ALTER TABLE contacts ADD COLUMN remote_vcard TEXT;
ALTER TABLE contacts ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX contacts_remote ON contacts(sync_account, remote_href);

CREATE TABLE contact_sync (
  account_id      INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  collection_url  TEXT,
  sync_token      TEXT,
  last_sync       TEXT,
  last_error      TEXT
);

CREATE TABLE contact_tombstones (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  href        TEXT NOT NULL,
  etag        TEXT
);
`
