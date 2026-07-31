-- Marketing: cliente pode ser EMPRESA ou NAVIO (navio recebe o site direto no
-- email de bordo e não tem cidade/UF). Aditivo com default — dados existentes
-- continuam como EMPRESA.
ALTER TABLE "marketing_clients" ADD COLUMN "client_type" TEXT NOT NULL DEFAULT 'EMPRESA';
