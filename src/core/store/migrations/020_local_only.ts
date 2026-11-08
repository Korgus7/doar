// Migrácia 020 – práca bez servera. NIKDY ju neupravuj; zmeny len novou migráciou.
//
// accounts.local_only: konto „len v počítači“ – schránka na serveri už neexistuje (alebo ju používateľ
// nechce používať), Doar sa na server nepripája a všetky zmeny (presuny, priečinky, mazanie) robí len lokálne.
// folders.hidden: priečinok odstránený bez pripojenia – v rozhraní sa už neukazuje, zo servera sa odstráni
// po pripojení (operácia folderDelete).
// Jedinečnosť adresy na serveri platí len pre pripojené kontá – schránku, ktorej staré konto ostalo len
// v počítači, možno pridať znova ako nové konto.
export default /* sql */ `
ALTER TABLE accounts ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
DROP INDEX accounts_email_host;
CREATE UNIQUE INDEX accounts_email_host ON accounts(lower(email), lower(imap_host)) WHERE local_only = 0;
`
