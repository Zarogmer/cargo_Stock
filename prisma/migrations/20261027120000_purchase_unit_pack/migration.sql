-- Controle de Compras: unidade da linha da nota (UN, CX, PCT, M...) e o que
-- vem dentro da embalagem ("CX com 30 DZ", "PCT com 100 UN"). Sem isso, uma
-- caixa de ovos de R$ 250 aparecia como "1 unidade a R$ 250". O Escanear (IA)
-- preenche; ao lançar no Almoxarifado a quantidade vira a unidade de dentro.
ALTER TABLE "purchase_orders" ADD COLUMN "unit" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "pack_qty" DOUBLE PRECISION;
ALTER TABLE "purchase_orders" ADD COLUMN "pack_unit" TEXT;
