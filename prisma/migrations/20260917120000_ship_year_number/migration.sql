-- Nº oficial do navio no ano — o número da pasta de fechamentos da diretoria
-- ("03 - RELATÓRIO DE DESPESAS DE LIMPEZA DE PORÕES"): cada planilha começa com
-- "27 - M/V FEDERAL IMABARI - ...". Esse número é a fonte oficial e agora fica
-- gravado; a numeração calculada por ordem de chegada (src/lib/ship-number.ts)
-- vira só o fallback pra navio sem número.
ALTER TABLE "ships" ADD COLUMN "year_number" INTEGER;

COMMENT ON COLUMN "ships"."year_number" IS
  'Nº do navio no ano na planilha da diretoria. NULL = numeração calculada por ordem de chegada.';
