// Migrácia 012 – výrazná paleta kont (po 0.7): predvolené farby z migrácie 011 nahradí lepšie rozlíšiteľnými.
// Farby, ktoré si používateľ zvolil inak (mimo palety), nemení.
export default /* sql */ `
UPDATE accounts SET color = CASE lower(color)
  WHEN '#2f6db5' THEN '#18a4d5'
  WHEN '#d0682a' THEN '#ff7614'
  WHEN '#2f8f4e' THEN '#9ddd08'
  WHEN '#8a4bb0' THEN '#793cf2'
  WHEN '#1f8f99' THEN '#00cea8'
  WHEN '#c43c3c' THEN '#f03a47'
  WHEN '#c99418' THEN '#f7dd12'
  WHEN '#4f62c4' THEN '#ed0da6'
  ELSE color END
WHERE lower(color) IN ('#2f6db5', '#d0682a', '#2f8f4e', '#8a4bb0', '#1f8f99', '#c43c3c', '#c99418', '#4f62c4');
`
