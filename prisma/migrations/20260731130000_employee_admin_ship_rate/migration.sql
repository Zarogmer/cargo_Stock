-- Administrativo por SETOR, valor por colaborador: o valor fixo por navio do
-- pessoal administrativo agora mora no próprio colaborador (employees.
-- admin_ship_rate), gravável direto do modal de Pagamento de Navios. Antes o
-- valor vinha do "valor especial" (employee_function_rates) da função
-- ADMINISTRATIVO — o backfill migra o que já estava configurado (maior valor
-- quando havia mais de um registro, ex.: função duplicada Embarque/Costado).
ALTER TABLE "employees" ADD COLUMN "admin_ship_rate" DECIMAL(10,2);

UPDATE "employees" e
SET "admin_ship_rate" = sub.rate
FROM (
  SELECT DISTINCT ON (efr.employee_id) efr.employee_id, efr.rate
  FROM "employee_function_rates" efr
  JOIN "job_functions" jf ON jf.id = efr.function_id
  WHERE UPPER(TRIM(jf.name)) = 'ADMINISTRATIVO' OR UPPER(jf.unit) = 'ADMIN_COSTADO'
  ORDER BY efr.employee_id, efr.rate DESC
) sub
WHERE sub.employee_id = e.id;

-- Consolida as alocações do administrativo numa única função-carregador: a
-- ADMINISTRATIVO "do Embarque" (unidade legada POR_OPERACAO/afins) ou, na
-- falta, a de menor id. Havia uma segunda ADMINISTRATIVO criada na seção
-- Costado que, por ordem alfabética, ainda sombreava a função principal real
-- do Costado (AUXILIAR OPERACIONAL) — as duplicadas somem depois de mover as
-- alocações (rates por função/colaborador delas caem em cascata; o que
-- importava já foi copiado pra employees.admin_ship_rate acima).
WITH canon AS (
  SELECT id FROM "job_functions"
  WHERE UPPER(TRIM(name)) = 'ADMINISTRATIVO'
  ORDER BY (CASE WHEN UPPER(unit) IN ('EMBARQUE', 'PORAO', 'POR_NAVIO', 'POR_OPERACAO', '') THEN 0 ELSE 1 END), id
  LIMIT 1
)
UPDATE "job_allocations" a
SET function_id = (SELECT id FROM canon)
FROM "job_functions" jf
WHERE jf.id = a.function_id
  AND (UPPER(TRIM(jf.name)) = 'ADMINISTRATIVO' OR UPPER(jf.unit) = 'ADMIN_COSTADO')
  AND jf.id <> (SELECT id FROM canon)
  AND EXISTS (SELECT 1 FROM canon);

DELETE FROM "job_functions" jf
WHERE (UPPER(TRIM(jf.name)) = 'ADMINISTRATIVO' OR UPPER(jf.unit) = 'ADMIN_COSTADO')
  AND NOT EXISTS (SELECT 1 FROM "job_allocations" a WHERE a.function_id = jf.id)
  AND EXISTS (
    SELECT 1 FROM "job_functions" k
    WHERE UPPER(TRIM(k.name)) = 'ADMINISTRATIVO' AND k.id <> jf.id
      AND EXISTS (SELECT 1 FROM "job_allocations" a2 WHERE a2.function_id = k.id)
  );
