-- Data de cada horário do porão no Relatório de Bordo. O navio começa num dia
-- e termina no outro (água doce das 15h do dia 12 até as 02h do dia 13), e só
-- com a hora não dava pra saber. ISO yyyy-mm-dd, uma pra cada horário: fases
-- da lavagem (salgada/doce) e o horário único de raspagem/pintura.
ALTER TABLE "ship_report_holds" ADD COLUMN "start_date" TEXT;
ALTER TABLE "ship_report_holds" ADD COLUMN "end_date" TEXT;
ALTER TABLE "ship_report_holds" ADD COLUMN "salt_start_date" TEXT;
ALTER TABLE "ship_report_holds" ADD COLUMN "salt_end_date" TEXT;
ALTER TABLE "ship_report_holds" ADD COLUMN "fresh_start_date" TEXT;
ALTER TABLE "ship_report_holds" ADD COLUMN "fresh_end_date" TEXT;
