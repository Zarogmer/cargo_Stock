-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "opening_balance" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "bank_transactions" ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "review_status" TEXT NOT NULL DEFAULT 'PENDENTE',
ADD COLUMN     "reviewed_at" TIMESTAMPTZ,
ADD COLUMN     "reviewed_by" TEXT;

