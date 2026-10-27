// Migrácia 014 – poštová adresa kontaktu (na klasický list), viac riadkov textu.
export default /* sql */ `
ALTER TABLE contacts ADD COLUMN address TEXT NOT NULL DEFAULT '';
`
