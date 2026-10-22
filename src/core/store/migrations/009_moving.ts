// Migrácia 009 – presun sa ukáže hneď: správa čakajúca na presun na serveri (čas na „Vrátiť späť“)
// je v zozname už v cieľovom priečinku (moving_to) so značkou „presúva sa“. Pôvodné umiestnenie
// (folder_id, uid) platí, kým presun nepotvrdí server.
export default /* sql */ `
ALTER TABLE messages ADD COLUMN moving_to INTEGER REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX messages_moving_to ON messages(moving_to);
`
