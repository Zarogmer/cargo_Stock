-- CreateTable
CREATE TABLE "financial_statement_entries" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "entry_date" DATE,
    "description" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "source_row" INTEGER NOT NULL,
    "imported_by" TEXT NOT NULL,
    "imported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_statement_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financial_statement_entries_year_month_idx" ON "financial_statement_entries"("year", "month");

-- CreateIndex
CREATE INDEX "financial_statement_entries_year_section_idx" ON "financial_statement_entries"("year", "section");
