-- Folha do Pagamento de Navios agora começa em 0: pluxee_value NULL passa a
-- significar "folha ainda não definida" (a coluna Folha mostra 0 até o
-- usuário editar na mão ou importar o Relatório de Líquidos). O DEFAULT 0
-- fazia toda alocação nova nascer com folha = total; sem default, quem não
-- informar o campo entra NULL. As linhas antigas ficam como estão (0 ou o
-- valor importado) e continuam exibindo folha = total - pluxee.
ALTER TABLE "job_allocations" ALTER COLUMN "pluxee_value" DROP DEFAULT;
