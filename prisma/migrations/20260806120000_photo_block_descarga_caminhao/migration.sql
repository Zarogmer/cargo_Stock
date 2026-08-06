-- Bloco de fotos "Descarregamento do caminhão" virou "Descarga do Caminhão".
-- Só renomeia o que já existe: sem isso a foto antiga ficaria num bloco à parte
-- na aba Fotos (e numa seção repetida no PDF).

-- Legenda do bloco: se o relatório já tiver as duas linhas (a nova criada
-- depois do deploy e a antiga), a antiga sai — a unique é (report_id, label).
DELETE FROM "ship_report_sections" s
WHERE s."label" = 'Descarregamento do caminhão'
  AND EXISTS (
    SELECT 1 FROM "ship_report_sections" t
    WHERE t."report_id" = s."report_id" AND t."label" = 'Descarga do Caminhão'
  );

UPDATE "ship_report_sections"
SET "label" = 'Descarga do Caminhão'
WHERE "label" = 'Descarregamento do caminhão';

UPDATE "ship_report_photos"
SET "hold_label" = 'Descarga do Caminhão'
WHERE "hold_label" = 'Descarregamento do caminhão';

-- O rótulo também é usado no registro de atividades (coluna hold_label).
UPDATE "ship_report_activities"
SET "hold_label" = 'Descarga do Caminhão'
WHERE "hold_label" = 'Descarregamento do caminhão';
