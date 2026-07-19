-- FATURADO parcelado: a compra guarda os prazos de cada parcela e passa a poder
-- gerar N títulos no Contas a Pagar (um por parcela), então o vínculo
-- payable_invoices.purchase_order_id deixa de ser único.

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "payment_terms" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- DropIndex
DROP INDEX "payable_invoices_purchase_order_id_key";

-- CreateIndex
CREATE INDEX "payable_invoices_purchase_order_id_idx" ON "payable_invoices"("purchase_order_id");
