// Migrácia 018 – konverzácie, skupiny v adresári, podpisy s formátovaním.
export default /* sql */ `
-- Konverzácie: správy jedného vlákna majú spoločný thread_key (dopočíta ho jadro, aj pre existujúcu poštu).
-- thread_subject = predmet bez „Re:“, „Fwd:“… (náhradné párovanie odpovedí).
ALTER TABLE messages ADD COLUMN thread_subject TEXT;
CREATE INDEX messages_thread ON messages(account_id, thread_key);
CREATE INDEX messages_account_msgid ON messages(account_id, message_id);
CREATE INDEX messages_reply_to ON messages(account_id, in_reply_to);
CREATE INDEX messages_thread_subject ON messages(account_id, thread_subject);

-- Skupiny v adresári (len v Doare, nesynchronizujú sa).
CREATE TABLE contact_groups (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
);
CREATE TABLE contact_group_members (
  group_id   INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, contact_id)
);
CREATE INDEX contact_group_members_contact ON contact_group_members(contact_id);

-- Podpisy: viac na konto, formátované (HTML, aj s logom). Doterajší textový podpis sa prenesie ako predvolený.
CREATE TABLE signatures (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  html       TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX signatures_account ON signatures(account_id, position);
INSERT INTO signatures (account_id, name, html, is_default)
  SELECT id, '', '<p>' || replace(replace(replace(replace(replace(trim(signature), char(13), ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), char(10), '<br>') || '</p>', 1
  FROM accounts WHERE trim(signature) != '';
`
