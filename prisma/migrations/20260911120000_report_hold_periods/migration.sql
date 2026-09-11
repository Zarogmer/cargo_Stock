-- Horários do porão viram uma LISTA de períodos (dia + início + término):
-- o pessoal para às 18h e volta no dia seguinte, então um porão tem vários
-- dias de trabalho, cada um com o seu início e fim, e o relatório soma as
-- horas trabalhadas. Formato: [{phase: SALT|FRESH|GERAL, date, start, end}].
-- SALT/FRESH = fases da lavagem; GERAL = raspagem/pintura (um horário só) e o
-- horário geral legado dos relatórios de antes das fases.
ALTER TABLE "ship_report_holds" ADD COLUMN "periods" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Copia o que já estava gravado nas colunas antigas (um período por fase).
UPDATE "ship_report_holds" h SET "periods" = COALESCE((
  SELECT jsonb_agg(s.p ORDER BY s.ord) FROM (
    SELECT 1 AS ord, jsonb_build_object('phase', 'SALT',
      'date', COALESCE(h.salt_start_date, h.salt_end_date),
      'start', h.salt_start, 'end', h.salt_end) AS p
    WHERE h.salt_start IS NOT NULL OR h.salt_end IS NOT NULL
    UNION ALL
    SELECT 2, jsonb_build_object('phase', 'FRESH',
      'date', COALESCE(h.fresh_start_date, h.fresh_end_date),
      'start', h.fresh_start, 'end', h.fresh_end)
    WHERE h.fresh_start IS NOT NULL OR h.fresh_end IS NOT NULL
    UNION ALL
    SELECT 3, jsonb_build_object('phase', 'GERAL',
      'date', COALESCE(h.start_date, h.end_date),
      'start', h.start_time, 'end', h.end_time)
    WHERE h.start_time IS NOT NULL OR h.end_time IS NOT NULL
  ) s
), '[]'::jsonb);

ALTER TABLE "ship_report_holds"
  DROP COLUMN "start_time",
  DROP COLUMN "end_time",
  DROP COLUMN "salt_start",
  DROP COLUMN "salt_end",
  DROP COLUMN "fresh_start",
  DROP COLUMN "fresh_end",
  DROP COLUMN "start_date",
  DROP COLUMN "end_date",
  DROP COLUMN "salt_start_date",
  DROP COLUMN "salt_end_date",
  DROP COLUMN "fresh_start_date",
  DROP COLUMN "fresh_end_date";
