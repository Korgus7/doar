// Migrácia 010 – nový vzhľad 0.6: pôvodné žiarivé predvolené farby kont nahradí tlmenými.
// Farby, ktoré si používateľ zvolil inak (mimo starej palety), nemení.
export default /* sql */ `
UPDATE accounts SET color = CASE lower(color)
  WHEN '#3b82f6' THEN '#4a6b96'
  WHEN '#e8590c' THEN '#b5683a'
  WHEN '#2f9e44' THEN '#4f7f5a'
  WHEN '#ae3ec9' THEN '#7d5b8f'
  WHEN '#0c8599' THEN '#3f7f84'
  WHEN '#e03131' THEN '#a3504a'
  WHEN '#f08c00' THEN '#b08a3e'
  WHEN '#5c7cfa' THEN '#5f6f8f'
  ELSE color END
WHERE lower(color) IN ('#3b82f6', '#e8590c', '#2f9e44', '#ae3ec9', '#0c8599', '#e03131', '#f08c00', '#5c7cfa');
`
