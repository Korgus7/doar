// Migrácia 004 – odosielacia fronta: údaje pre zobrazenie a odpoveď bez parsovania originálu.
export default /* sql */ `
ALTER TABLE outbox ADD COLUMN subject TEXT NOT NULL DEFAULT '';
ALTER TABLE outbox ADD COLUMN recipients_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outbox ADD COLUMN reply_to_message INTEGER;
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX outbox_account_state ON outbox(account_id, state);
`
