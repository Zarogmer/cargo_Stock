-- Desconto manual por colaborador no navio (coluna Desc. Geral clicável). Soma
-- ao rateio automático de material perdido e é abatido do líquido.
ALTER TABLE "job_allocations" ADD COLUMN "general_discount" DECIMAL(10,2) DEFAULT 0;
