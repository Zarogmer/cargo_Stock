-- Equipe e Navio (opcionais) no título do Contas a Pagar: herdados da compra ou
-- informados na Nova conta. Servem pra filtrar por equipe/navio.
ALTER TABLE "payable_invoices" ADD COLUMN "team" TEXT;
ALTER TABLE "payable_invoices" ADD COLUMN "ship_id" UUID;
ALTER TABLE "payable_invoices" ADD COLUMN "ship_name" TEXT;
