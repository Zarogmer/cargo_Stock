-- Demonstração Financeira vira uma visão dos títulos do Contas a Pagar: cada
-- título pode ter uma seção da demonstração ("6.1".."12"). Os lançamentos já
-- importados da planilha são migrados pra títulos pelo script
-- scripts/sync-demonstracao-contas.ts (dados, não schema).

-- AlterEnum
ALTER TYPE "PayableOrigin" ADD VALUE 'DEMONSTRACAO';

-- AlterTable
ALTER TABLE "payable_invoices" ADD COLUMN     "statement_section" TEXT;

-- CreateIndex
CREATE INDEX "payable_invoices_statement_section_idx" ON "payable_invoices"("statement_section");
