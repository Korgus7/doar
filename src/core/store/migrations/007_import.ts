// Migrácia 007 – obnova zo zálohy (import mbox do konta). Každá správa súboru je jeden riadok import_items;
// stav sa ukladá priebežne, aby sa po prerušení dalo bezpečne pokračovať.
export default /* sql */ `
ALTER TABLE import_items ADD COLUMN mbox_length INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_items ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_items ADD COLUMN weak_key TEXT NOT NULL DEFAULT '';
ALTER TABLE import_items ADD COLUMN target_desc TEXT NOT NULL DEFAULT '';
ALTER TABLE import_items ADD COLUMN target_uidvalidity INTEGER;
ALTER TABLE import_items ADD COLUMN changed_outside INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_items ADD COLUMN foreign_format INTEGER NOT NULL DEFAULT 0;
CREATE INDEX import_items_fingerprint ON import_items(fingerprint, target_folder);
CREATE INDEX jobs_kind_state ON jobs(kind, state);
`
