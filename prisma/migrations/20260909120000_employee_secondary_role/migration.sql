-- 2ª função do colaborador (opcional). Na prática um WAP às vezes sobe como
-- SUPERVISOR ou ESFREGÃO: a 2ª função registra isso no cadastro. Conta junto
-- com a principal onde se pergunta "quem é SUPERVISOR?" (Rh › Usuários) e
-- aparece como dica nas telas de escalação. Texto casando com
-- job_functions.name, igual à coluna role (sem FK).
ALTER TABLE "employees" ADD COLUMN "secondary_role" TEXT;
