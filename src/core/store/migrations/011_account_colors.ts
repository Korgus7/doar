// Migrácia 011 – výraznejšie farby kont (po 0.6): tlmené predvolené farby z migrácie 010 nahradí sýtejšími.
// Farby, ktoré si používateľ zvolil inak (mimo palety), nemení.
export default /* sql */ `
UPDATE accounts SET color = CASE lower(color)
  WHEN '#4a6b96' THEN '#2f6db5'
  WHEN '#b5683a' THEN '#d0682a'
  WHEN '#4f7f5a' THEN '#2f8f4e'
  WHEN '#7d5b8f' THEN '#8a4bb0'
  WHEN '#3f7f84' THEN '#1f8f99'
  WHEN '#a3504a' THEN '#c43c3c'
  WHEN '#b08a3e' THEN '#c99418'
  WHEN '#5f6f8f' THEN '#4f62c4'
  ELSE color END
WHERE lower(color) IN ('#4a6b96', '#b5683a', '#4f7f5a', '#7d5b8f', '#3f7f84', '#a3504a', '#b08a3e', '#5f6f8f');
`
