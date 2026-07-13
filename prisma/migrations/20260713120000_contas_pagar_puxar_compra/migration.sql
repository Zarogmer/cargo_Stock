-- AlterEnum
ALTER TYPE "PayableOrigin" ADD VALUE 'COMPRA';

-- AlterTable
ALTER TABLE "payable_invoices" ADD COLUMN     "purchase_order_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "payable_invoices_purchase_order_id_key" ON "payable_invoices"("purchase_order_id");

-- AddForeignKey
ALTER TABLE "payable_invoices" ADD CONSTRAINT "payable_invoices_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
