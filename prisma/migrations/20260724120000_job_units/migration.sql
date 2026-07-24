-- Unidades cadastráveis (nome + descrição). Viram as seções das abas Valores e
-- Funções. As funções continuam apontando pela string job_functions.unit; aqui o
-- `name` é a chave (mesmo valor que unitToOption() resolve pra cada função).
CREATE TABLE "job_units" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 50,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_units_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_units_name_key" ON "job_units"("name");

-- Seed dos três grupos canônicos (mesma ordem e textos das seções de hoje).
INSERT INTO "job_units" ("name", "description", "sort_order") VALUES
    ('EMBARQUE',   'Pago por porão — inclui os extras Raspagem e Pintura', 10),
    ('COSTADO',    'Pago por turno', 20),
    ('MENSALISTA', 'Salário fixo mensal', 90)
ON CONFLICT ("name") DO NOTHING;

-- Seed das unidades personalizadas que já existem em funções (ex.: TESTE), pra
-- nenhuma seção sumir. Legados (PORAO, POR_NAVIO, TURNO...) NÃO entram: eles caem
-- nos grupos canônicos acima.
INSERT INTO "job_units" ("name", "description", "sort_order")
SELECT DISTINCT UPPER(TRIM("unit")), 'Unidade personalizada', 50
FROM "job_functions"
WHERE UPPER(TRIM("unit")) NOT IN (
    'EMBARQUE', 'COSTADO', 'MENSALISTA',
    'PORAO', 'POR_NAVIO', 'POR_OPERACAO', 'TURNO', 'POR_DIA', 'POR_HORA', 'ADMIN_COSTADO', ''
)
ON CONFLICT ("name") DO NOTHING;
