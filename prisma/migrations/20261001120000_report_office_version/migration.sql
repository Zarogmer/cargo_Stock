-- Versão do escritório do Cleaning Report: cópia editável pela gestão na aba
-- Gerar Relatórios, usada no PDF pro cliente sem mexer no que o supervisor
-- escreveu. NULL = o PDF sai do relatório do supervisor.
ALTER TABLE "ship_reports" ADD COLUMN "office_version" JSONB;
ALTER TABLE "ship_reports" ADD COLUMN "office_version_by" TEXT;
ALTER TABLE "ship_reports" ADD COLUMN "office_version_at" TIMESTAMPTZ;
