// Migrácia 013 – adresár: kontakty, ktoré používateľ uložil alebo importoval (jedna e-mailová adresa na kontakt).
// Adresy z pošty (tabuľka addresses) ostávajú oddelene – do adresára sa dostanú, až keď ich používateľ uloží.
export default /* sql */ `
CREATE TABLE contacts (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL COLLATE NOCASE,
  phone       TEXT NOT NULL DEFAULT '',
  company     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX contacts_email ON contacts(email);
`
