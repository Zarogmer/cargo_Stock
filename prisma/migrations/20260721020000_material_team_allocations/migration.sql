-- Alocação de material por equipe. `stock_items.quantity` segue sendo o TOTAL;
-- o "Disponível" no almoxarifado = total − soma das alocações. Transferir do
-- Disponível pra uma equipe cria/soma uma linha aqui (total não muda). Ao
-- embarcar, a equipe consome a alocação dela.
CREATE TABLE "material_team_allocations" (
    "id" SERIAL NOT NULL,
    "stock_item_id" INTEGER NOT NULL,
    "team" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "material_team_allocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "material_team_allocations_stock_item_id_team_key" ON "material_team_allocations"("stock_item_id", "team");

CREATE INDEX "material_team_allocations_stock_item_id_idx" ON "material_team_allocations"("stock_item_id");

ALTER TABLE "material_team_allocations" ADD CONSTRAINT "material_team_allocations_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: as poucas linhas de material que hoje estão marcadas com assigned_team
-- de equipe (mecanismo antigo, praticamente sem uso) viram alocação. A quantidade
-- dessas linhas já saiu do "pote" do Disponível, então aqui só registramos a quem
-- pertence. Setores de material: GALPAO/FERRAMENTA/ELETRICA/FLUIDOS/MAQUINARIO.
INSERT INTO "material_team_allocations" ("stock_item_id", "team", "quantity", "updated_by")
SELECT "id", "assigned_team", "quantity", 'Migração (assigned_team → alocação)'
FROM "stock_items"
WHERE "team" IN ('GALPAO', 'FERRAMENTA', 'ELETRICA', 'FLUIDOS', 'MAQUINARIO')
  AND "assigned_team" IN ('EQUIPE_1', 'EQUIPE_2', 'EQUIPE_4')
  AND "quantity" > 0
ON CONFLICT ("stock_item_id", "team") DO NOTHING;
