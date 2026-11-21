// Migrácia 022 – stav vybavenia správy (krúžok). NIKDY ju neupravuj; zmeny len novou migráciou.
//
// messages.mark: 0 bez stavu, 1 veľmi dôležité, 2 dôležité, 3 vybavené. Na serveri vlastná značka
// ($DoarHigh, $DoarMedium, $DoarDone), ak ju server vie uložiť; inak ostáva len v tomto počítači.
export default /* sql */ `
ALTER TABLE messages ADD COLUMN mark INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET mark = CASE
  WHEN keywords_json LIKE '%"$DoarHigh"%' THEN 1
  WHEN keywords_json LIKE '%"$DoarMedium"%' THEN 2
  WHEN keywords_json LIKE '%"$DoarDone"%' THEN 3
  ELSE 0 END;
`
