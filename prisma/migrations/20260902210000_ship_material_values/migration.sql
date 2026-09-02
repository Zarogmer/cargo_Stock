-- Valor unitário de material POR NAVIO (Pagamento de Navios › Retorno de
-- material). O padrão vem do Almoxarifado (stock_items.unit_value); editar o
-- unitário no modal do navio grava aqui e vale só pra aquele navio — antes a
-- edição sobrescrevia stock_items.unit_value e mudava o valor em TODOS os
-- navios. Tabela própria (não coluna em material_return_items) porque a
-- edição do retorno apaga e reinsere os itens.
CREATE TABLE "ship_material_values" (
    "id" SERIAL NOT NULL,
    "ship_id" UUID NOT NULL,
    "stock_item_id" INTEGER NOT NULL,
    "unit_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "ship_material_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ship_material_values_ship_id_stock_item_id_key" ON "ship_material_values"("ship_id", "stock_item_id");

ALTER TABLE "ship_material_values" ADD CONSTRAINT "ship_material_values_ship_id_fkey" FOREIGN KEY ("ship_id") REFERENCES "ships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ship_material_values" ADD CONSTRAINT "ship_material_values_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
