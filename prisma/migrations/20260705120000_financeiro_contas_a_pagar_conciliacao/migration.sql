-- CreateEnum
CREATE TYPE "PayableStatus" AS ENUM ('RECEBIDO', 'AGUARDANDO_APROVACAO', 'APROVADO', 'PAGO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "PayableOrigin" AS ENUM ('EMAIL', 'MANUAL');

-- CreateEnum
CREATE TYPE "BankKind" AS ENUM ('ITAU', 'SANTANDER', 'OUTRO');

-- CreateEnum
CREATE TYPE "TransactionSource" AS ENUM ('OFX_FILE', 'CNAB_FILE', 'API_ITAU', 'API_SANTANDER');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('SUGERIDA', 'CONFIRMADA', 'REJEITADA');

-- CreateEnum
CREATE TYPE "FinanceJobStatus" AS ENUM ('PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'ERRO');

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "cnpj" TEXT,
ADD COLUMN     "email" TEXT;

-- CreateTable
CREATE TABLE "payable_invoices" (
    "id" UUID NOT NULL,
    "supplier_id" INTEGER,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "due_date" DATE,
    "status" "PayableStatus" NOT NULL DEFAULT 'RECEBIDO',
    "origin" "PayableOrigin" NOT NULL DEFAULT 'MANUAL',
    "digitable_line" TEXT,
    "barcode" TEXT,
    "payee_name" TEXT,
    "payee_document" TEXT,
    "notes" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ,
    "paid_by" TEXT,
    "paid_at" TIMESTAMPTZ,
    "cancelled_by" TEXT,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payable_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_attachments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'application/pdf',
    "content" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "source_message_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" SERIAL NOT NULL,
    "bank" "BankKind" NOT NULL,
    "nickname" TEXT NOT NULL,
    "agency" TEXT,
    "account_number" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "api_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" UUID NOT NULL,
    "bank_account_id" INTEGER NOT NULL,
    "posted_at" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT,
    "payee_name" TEXT,
    "payee_document" TEXT,
    "external_id" TEXT,
    "dedupe_hash" TEXT NOT NULL,
    "source" "TransactionSource" NOT NULL,
    "raw" JSONB,
    "imported_by" TEXT,
    "imported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" SERIAL NOT NULL,
    "transaction_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'SUGERIDA',
    "score" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "matched_by" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_logs" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "message" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_integration_accounts" (
    "id" SERIAL NOT NULL,
    "mailbox" TEXT NOT NULL,
    "tenant_id" TEXT,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMPTZ,
    "delta_token" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_sync_at" TIMESTAMPTZ,
    "last_status" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_integration_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_jobs" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupe_key" TEXT,
    "status" "FinanceJobStatus" NOT NULL DEFAULT 'PENDENTE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "run_after" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payable_invoices_digitable_line_key" ON "payable_invoices"("digitable_line");

-- CreateIndex
CREATE INDEX "payable_invoices_status_idx" ON "payable_invoices"("status");

-- CreateIndex
CREATE INDEX "payable_invoices_due_date_idx" ON "payable_invoices"("due_date");

-- CreateIndex
CREATE INDEX "payable_invoices_supplier_id_idx" ON "payable_invoices"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_attachments_sha256_key" ON "invoice_attachments"("sha256");

-- CreateIndex
CREATE INDEX "invoice_attachments_invoice_id_idx" ON "invoice_attachments"("invoice_id");

-- CreateIndex
CREATE INDEX "bank_transactions_posted_at_idx" ON "bank_transactions"("posted_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_bank_account_id_external_id_key" ON "bank_transactions"("bank_account_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_bank_account_id_dedupe_hash_key" ON "bank_transactions"("bank_account_id", "dedupe_hash");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliations_transaction_id_key" ON "reconciliations"("transaction_id");

-- CreateIndex
CREATE INDEX "reconciliations_invoice_id_idx" ON "reconciliations"("invoice_id");

-- CreateIndex
CREATE INDEX "reconciliations_status_idx" ON "reconciliations"("status");

-- CreateIndex
CREATE INDEX "integration_logs_created_at_idx" ON "integration_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "integration_logs_provider_idx" ON "integration_logs"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "email_integration_accounts_mailbox_key" ON "email_integration_accounts"("mailbox");

-- CreateIndex
CREATE UNIQUE INDEX "finance_jobs_dedupe_key_key" ON "finance_jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "finance_jobs_status_run_after_idx" ON "finance_jobs"("status", "run_after");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_cnpj_key" ON "suppliers"("cnpj");

-- AddForeignKey
ALTER TABLE "payable_invoices" ADD CONSTRAINT "payable_invoices_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "payable_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "bank_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "payable_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

