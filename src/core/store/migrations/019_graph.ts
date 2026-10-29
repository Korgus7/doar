// Migrácia 019 – kontá cez Microsoft Graph (Outlook.com, Microsoft 365). NIKDY ju neupravuj; zmeny len novou migráciou.
//
// protocol: 'imap' (IMAP + SMTP) alebo 'graph' (Microsoft Graph – čítanie aj odosielanie cez HTTPS).
// Pri Graph je folders.path ID priečinka v Graph (stále, aj po premenovaní), folders.delimiter NULL
// a hĺbka sa počíta podľa parent_path. messages.uid je lokálne poradové číslo v priečinku, skutočné ID
// správy v Graph (nemenné – ImmutableId, platí aj po presune) je v messages.remote_id.
// folders.delta_link – odkaz na ďalšiu „delta“ synchronizáciu priečinka (len zmeny od minule).
export default /* sql */ `
ALTER TABLE accounts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'imap' CHECK (protocol IN ('imap','graph'));
ALTER TABLE folders ADD COLUMN delta_link TEXT;
ALTER TABLE messages ADD COLUMN remote_id TEXT;
CREATE INDEX messages_remote ON messages(folder_id, remote_id);

-- Doterajšie kontá s prihlásením cez Microsoft (IMAP/SMTP s tokenom) prejdú na Graph. Ich priečinky
-- a správy z IMAP sa zahodia (načítajú sa znova cez Graph); originály .eml v úložisku ostávajú.
DELETE FROM operations WHERE account_id IN (SELECT id FROM accounts WHERE auth_type = 'oauth2' AND provider_key = 'microsoft');
DELETE FROM folders WHERE account_id IN (SELECT id FROM accounts WHERE auth_type = 'oauth2' AND provider_key = 'microsoft');
UPDATE accounts SET protocol = 'graph', imap_host = 'graph.microsoft.com', imap_port = 443, imap_security = 'tls',
  smtp_host = 'graph.microsoft.com', smtp_port = 443, smtp_security = 'tls'
  WHERE auth_type = 'oauth2' AND provider_key = 'microsoft';
`
