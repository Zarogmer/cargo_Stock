-- Escanear (IA) no Controle de Compras: os itens de uma mesma nota/boleto
-- viram compras separadas com o mesmo batch_id, e o Contas a Pagar lança um
-- título só pro lote (purchase_batch_id marca o lote como lançado).
ALTER TABLE "purchase_orders" ADD COLUMN "batch_id" UUID;
CREATE INDEX "purchase_orders_batch_id_idx" ON "purchase_orders"("batch_id");

ALTER TABLE "payable_invoices" ADD COLUMN "purchase_batch_id" UUID;
CREATE INDEX "payable_invoices_purchase_batch_id_idx" ON "payable_invoices"("purchase_batch_id");
