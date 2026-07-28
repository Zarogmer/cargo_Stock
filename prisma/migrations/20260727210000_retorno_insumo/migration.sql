-- Retorno de material: separa "insumo" (consumido de propósito — graxa, química,
-- etc) do avariado/perdido. O insumo não volta pra prateleira, mas NÃO custa nada
-- ao navio: é consumo normal, não perda.
ALTER TABLE "material_return_items" ADD COLUMN "consumed_qty" INTEGER NOT NULL DEFAULT 0;
