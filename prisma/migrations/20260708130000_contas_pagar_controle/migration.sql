-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayableOrigin" ADD VALUE 'BOLETO_PDF';
ALTER TYPE "PayableOrigin" ADD VALUE 'EXTRATO';

-- AlterTable
ALTER TABLE "payable_invoices" ADD COLUMN     "bank" TEXT,
ADD COLUMN     "expense_type" TEXT,
ADD COLUMN     "import_hash" TEXT,
ADD COLUMN     "paid_amount" DECIMAL(12,2),
ADD COLUMN     "payment_date" DATE;

-- CreateIndex
CREATE UNIQUE INDEX "payable_invoices_import_hash_key" ON "payable_invoices"("import_hash");

