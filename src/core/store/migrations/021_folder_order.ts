// Migrácia 021 – vlastné poradie priečinkov. NIKDY ju neupravuj; zmeny len novou migráciou.
//
// folders.sort_order: poradie medzi priečinkami na tej istej úrovni, ako ich používateľ poprehadzoval
// (ťahaním). IMAP poradie nepozná – drží sa len v Doare. NULL = abecedne (za ručne zoradenými).
export default /* sql */ `
ALTER TABLE folders ADD COLUMN sort_order INTEGER;
`
