// Migrácia 003 – podpora synchronizácie: fulltext sa maže spolu so správou, indexy pre zoznam a sťahovanie.
export default /* sql */ `
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
END;
CREATE INDEX messages_folder_seen ON messages(folder_id, seen);
CREATE INDEX messages_need_body ON messages(account_id, internal_date DESC) WHERE blob_sha256 IS NULL;
CREATE INDEX operations_pending ON operations(account_id, id) WHERE state IN ('pending', 'failed');
`
