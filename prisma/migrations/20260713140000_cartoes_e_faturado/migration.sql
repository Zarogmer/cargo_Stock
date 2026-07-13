-- CreateTable
CREATE TABLE "cards" (
    "id" SERIAL NOT NULL,
    "bank_account_id" INTEGER NOT NULL,
    "last4" TEXT NOT NULL,
    "closing_day" INTEGER NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cards_bank_account_id_idx" ON "cards"("bank_account_id");

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "payment_term_days" INTEGER,
ADD COLUMN     "card_id" INTEGER;

-- CreateIndex
CREATE INDEX "purchase_orders_card_id_idx" ON "purchase_orders"("card_id");

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
