-- Contas a Pagar vira o controle principal do financeiro: forma de pagamento
-- (herdada do Controle de Compras) + classificacao mensal/unica para filtro.
ALTER TABLE "payable_invoices" ADD COLUMN IF NOT EXISTS "payment_method" TEXT;
ALTER TABLE "payable_invoices" ADD COLUMN IF NOT EXISTS "recurrence" TEXT NOT NULL DEFAULT 'UNICA';
