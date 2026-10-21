// Migrácia 002 – kde je uložené heslo konta: 'os' (šifrované úložisko systému) alebo 'session' (len do zatvorenia).
export default /* sql */ `
ALTER TABLE accounts ADD COLUMN password_storage TEXT NOT NULL DEFAULT 'os' CHECK (password_storage IN ('os','session'));
CREATE UNIQUE INDEX accounts_email_host ON accounts(lower(email), lower(imap_host));
`
