-- Fechamento de Navio (Financeiro › Fechamento de Navio): a planilha
-- "NN - FECHAMENTO <NAVIO> - <CLIENTE>.xlsx" da diretoria, editável na tela.
-- Uma linha por job; `data` guarda o documento inteiro (ClosingDoc em
-- src/lib/fechamento-navio.ts). Sem linha = rascunho montado da escala.
CREATE TABLE "job_closings" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_closings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_closings_job_id_key" ON "job_closings"("job_id");

ALTER TABLE "job_closings" ADD CONSTRAINT "job_closings_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
