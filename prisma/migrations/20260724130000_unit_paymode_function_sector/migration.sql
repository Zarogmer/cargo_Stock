-- Unidade: como paga. PORAO (por porão, como Embarque), TURNO (por turno, como
-- Costado) ou MENSAL (salário fixo, como Mensalista). PORAO/TURNO entram na
-- escala do navio; MENSAL fica fora. Default PORAO (mesmo comportamento das
-- unidades personalizadas de hoje).
ALTER TABLE "job_units" ADD COLUMN "pay_mode" TEXT NOT NULL DEFAULT 'PORAO';
UPDATE "job_units" SET "pay_mode" = 'TURNO'  WHERE UPPER(TRIM("name")) = 'COSTADO';
UPDATE "job_units" SET "pay_mode" = 'MENSAL' WHERE UPPER(TRIM("name")) = 'MENSALISTA';

-- Função: setor que recebe. OPERACIONAL entra na escala do navio; ADMINISTRATIVO
-- é pessoal de escritório (fica fora da escala; custo do navio automático).
-- Default OPERACIONAL. Semeia como ADMINISTRATIVO a função ADMINISTRATIVO (o
-- custo fixo do escritório) e as mensalistas/admin legadas (ex.: Analista RH).
ALTER TABLE "job_functions" ADD COLUMN "sector" TEXT NOT NULL DEFAULT 'OPERACIONAL';
UPDATE "job_functions" SET "sector" = 'ADMINISTRATIVO'
 WHERE UPPER(TRIM("name")) = 'ADMINISTRATIVO'
    OR UPPER(TRIM("unit")) IN ('MENSALISTA', 'POR_DIA', 'POR_HORA', 'ADMIN_COSTADO');
