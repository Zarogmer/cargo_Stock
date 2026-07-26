-- Nome de função deixa de ser único no sistema todo e passa a ser único POR
-- UNIDADE (job_functions.unit + name). Assim o mesmo cargo pode existir em
-- unidades diferentes (ex.: AJUDANTE no Embarque e no Costado). Como o nome era
-- global até aqui, não há pares (unit, name) repetidos — a troca é segura.
DROP INDEX "job_functions_name_key";
CREATE UNIQUE INDEX "job_functions_unit_name_key" ON "job_functions"("unit", "name");
