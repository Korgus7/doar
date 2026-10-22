// Migrácia 005 – presuny a mazanie: správa sa hneď skryje (hidden), operácia na serveri môže počkať
// na uplynutie času na „Vrátiť späť“ (not_before).
export default /* sql */ `
ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN not_before TEXT;
CREATE INDEX messages_folder_visible ON messages(folder_id, hidden);
`
