-- Override de função travado por navio (executivo+). Aplicado à mão em produção
-- (o deploy não roda migração — ver memória deploy-no-auto-migrate).
-- Idempotente e aditivo: seguro rodar mais de uma vez.
ALTER TABLE "job_allocations"
  ADD COLUMN IF NOT EXISTS "function_locked" BOOLEAN NOT NULL DEFAULT false;
