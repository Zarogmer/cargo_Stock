-- Contas mensais (recorrentes) do Contas a Pagar: o modelo (recurring_bills)
-- e o vínculo no título gerado. O par (recorrência, vencimento) é único — é o
-- que torna o materializador idempotente.

-- CreateTable
CREATE TABLE "recurring_bills" (
    "id" SERIAL NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "due_day" INTEGER NOT NULL,
    "supplier_id" INTEGER,
    "payee_name" TEXT,
    "bank" TEXT,
    "expense_type" TEXT,
    "statement_section" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "start_month" TEXT NOT NULL,
    "end_month" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_bills_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "payable_invoices" ADD COLUMN     "recurring_bill_id" INTEGER;

-- CreateIndex
CREATE INDEX "payable_invoices_recurring_bill_id_idx" ON "payable_invoices"("recurring_bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "payable_invoices_recurring_bill_id_due_date_key" ON "payable_invoices"("recurring_bill_id", "due_date");

-- AddForeignKey
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_invoices" ADD CONSTRAINT "payable_invoices_recurring_bill_id_fkey" FOREIGN KEY ("recurring_bill_id") REFERENCES "recurring_bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
