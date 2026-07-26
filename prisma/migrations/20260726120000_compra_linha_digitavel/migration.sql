-- Linha digitável do boleto na compra (Controle de Compras). Antes ia junto na
-- Observação; agora tem campo próprio, preenchido ao escanear o boleto ou
-- importar a NF (PDF).
ALTER TABLE "purchase_orders" ADD COLUMN "digitable_line" TEXT;
