-- Lavagem de porão tem duas fases com horários próprios: água salgada (lavagem)
-- e água doce (enxágue). Cada porão/área do relatório passa a registrar o
-- início/término de cada fase. start_time/end_time seguem como legado (relatórios
-- gravados antes desta mudança) — o PDF cai neles quando as fases estão vazias.
ALTER TABLE "ship_report_holds" ADD COLUMN "salt_start" TEXT;
ALTER TABLE "ship_report_holds" ADD COLUMN "salt_end" TEXT;
ALTER TABLE "ship_report_holds" ADD COLUMN "fresh_start" TEXT;
ALTER TABLE "ship_report_holds" ADD COLUMN "fresh_end" TEXT;
