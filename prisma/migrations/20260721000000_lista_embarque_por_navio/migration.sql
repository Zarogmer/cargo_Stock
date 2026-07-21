-- Ajustes da lista de embarque por navio (aba Embarque/Retorno): quanto a
-- equipe leva de cada item NAQUELE navio (kit/rancho), incluindo itens extras
-- puxados do Estoque/Rancho. O kit oficial (embark_kit_items) fica intacto.
CREATE TABLE "embark_list_overrides" (
    "id" SERIAL NOT NULL,
    "ship_id" UUID NOT NULL,
    "team" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "stock_item_id" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embark_list_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "embark_list_overrides_ship_id_stock_item_id_key" ON "embark_list_overrides"("ship_id", "stock_item_id");

CREATE INDEX "embark_list_overrides_ship_id_idx" ON "embark_list_overrides"("ship_id");

ALTER TABLE "embark_list_overrides" ADD CONSTRAINT "embark_list_overrides_ship_id_fkey" FOREIGN KEY ("ship_id") REFERENCES "ships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "embark_list_overrides" ADD CONSTRAINT "embark_list_overrides_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Equipe Turbo (EQUIPE_4) agora pode ser Equipe Designada de navio: o kit de
-- materiais dela nasce como cópia do da Equipe 1 (mesmo padrão da Equipe 2 no
-- import do Check List). Idempotente: se já existir linha, mantém.
INSERT INTO "embark_kit_items" ("team", "stock_item_id", "quantity")
SELECT 'EQUIPE_4', "stock_item_id", "quantity"
FROM "embark_kit_items"
WHERE "team" = 'EQUIPE_1'
ON CONFLICT ("team", "stock_item_id") DO NOTHING;
