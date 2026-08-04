-- Blocos de foto do relatório fotográfico. Os blocos fixos (locais do ciclo da
-- operação + porões do cadastro do navio) são montados pela tela; esta tabela
-- guarda a legenda do bloco e os blocos criados à mão pelo supervisor.
CREATE TABLE "ship_report_sections" (
    "id" SERIAL NOT NULL,
    "report_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "caption" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ship_report_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ship_report_sections_report_id_idx" ON "ship_report_sections"("report_id");

-- CreateIndex: um bloco por rótulo dentro do relatório.
CREATE UNIQUE INDEX "ship_report_sections_report_id_label_key" ON "ship_report_sections"("report_id", "label");

-- AddForeignKey
ALTER TABLE "ship_report_sections" ADD CONSTRAINT "ship_report_sections_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "ship_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
