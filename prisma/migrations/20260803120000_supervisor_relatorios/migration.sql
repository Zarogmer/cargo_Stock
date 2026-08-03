-- Papel SUPERVISOR: usuário criado pelo RH, vinculado a um colaborador. Só
-- enxerga os Relatórios de Bordo dos navios em que o colaborador está escalado.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPERVISOR';

-- Vínculo usuário → colaborador (obrigatório na prática pros supervisores; os
-- demais papéis seguem sem vínculo). SET NULL: apagar o colaborador não pode
-- derrubar o login.
ALTER TABLE "users" ADD COLUMN "employee_id" INTEGER;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "users_employee_id_idx" ON "users"("employee_id");

-- CreateTable: um relatório por job+serviço (EMBARQUE ou COSTADO). Guarda o
-- cabeçalho (data, porto, status geral, observações e ETC) do relatório de
-- lavagem; porões/áreas, atividades e fotos ficam nas tabelas filhas.
CREATE TABLE "ship_reports" (
    "id" UUID NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'EMBARQUE',
    "report_date" DATE,
    "port" TEXT,
    "status" TEXT NOT NULL DEFAULT 'EM_ANDAMENTO',
    "remarks" TEXT,
    "etc_date" TEXT,
    "etc_time" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ship_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable: um porão (Embarque) ou área do costado, com status/horários da
-- lavagem — vira a tabela "Operational Status" do PDF.
CREATE TABLE "ship_report_holds" (
    "id" SERIAL NOT NULL,
    "report_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "start_time" TEXT,
    "end_time" TEXT,
    "completion_pct" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ship_report_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable: registro de atividades do dia (Daily Activities Log do PDF).
CREATE TABLE "ship_report_activities" (
    "id" SERIAL NOT NULL,
    "report_id" UUID NOT NULL,
    "time_range" TEXT,
    "activity" TEXT NOT NULL,
    "hold_label" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ship_report_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable: fotos do relatório fotográfico. A imagem entra como data URL
-- JPEG já comprimida e com a marca d'água da Cargo queimada no cliente —
-- inline no Postgres (infra só Railway, sem storage externo; mesmo racional
-- de stock_items.image_url).
CREATE TABLE "ship_report_photos" (
    "id" SERIAL NOT NULL,
    "report_id" UUID NOT NULL,
    "hold_label" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'ANTES',
    "caption" TEXT,
    "image_data" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ship_report_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable: avaliação de desempenho de um colaborador num navio (7 critérios
-- de 1 a 5; 0 = ainda não avaliado). Uma por colaborador por job+serviço.
CREATE TABLE "performance_evaluations" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'EMBARQUE',
    "employee_id" INTEGER NOT NULL,
    "productivity" INTEGER NOT NULL DEFAULT 0,
    "quality" INTEGER NOT NULL DEFAULT 0,
    "teamwork" INTEGER NOT NULL DEFAULT 0,
    "safety" INTEGER NOT NULL DEFAULT 0,
    "initiative" INTEGER NOT NULL DEFAULT 0,
    "punctuality" INTEGER NOT NULL DEFAULT 0,
    "technical" INTEGER NOT NULL DEFAULT 0,
    "comments" TEXT,
    "evaluated_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ship_reports_job_id_kind_key" ON "ship_reports"("job_id", "kind");

-- CreateIndex
CREATE INDEX "ship_report_holds_report_id_idx" ON "ship_report_holds"("report_id");

-- CreateIndex
CREATE INDEX "ship_report_activities_report_id_idx" ON "ship_report_activities"("report_id");

-- CreateIndex
CREATE INDEX "ship_report_photos_report_id_idx" ON "ship_report_photos"("report_id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_evaluations_job_id_kind_employee_id_key" ON "performance_evaluations"("job_id", "kind", "employee_id");

-- CreateIndex
CREATE INDEX "performance_evaluations_employee_id_idx" ON "performance_evaluations"("employee_id");

-- AddForeignKey
ALTER TABLE "ship_reports" ADD CONSTRAINT "ship_reports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ship_report_holds" ADD CONSTRAINT "ship_report_holds_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "ship_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ship_report_activities" ADD CONSTRAINT "ship_report_activities_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "ship_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ship_report_photos" ADD CONSTRAINT "ship_report_photos_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "ship_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_evaluations" ADD CONSTRAINT "performance_evaluations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_evaluations" ADD CONSTRAINT "performance_evaluations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
