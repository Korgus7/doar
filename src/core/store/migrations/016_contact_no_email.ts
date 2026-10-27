// Migrácia 016 – kontakt nemusí mať e-mail (len telefón alebo adresa, napr. kontakty z mobilu).
// E-mail ostáva jedinečný, ale len keď je vyplnený.
export default /* sql */ `
DROP INDEX contacts_email;
CREATE UNIQUE INDEX contacts_email_set ON contacts(email) WHERE email != '';
`
