-- Separação Navios × Embarque/Retorno:
--  • navio novo já nasce EM_OPERACAO (o usuário abre/fecha na aba Navios);
--  • o embarque vira estado próprio (embarked_at) — a Manutenção embarca/retorna
--    no tempo dela, sem mexer no status do navio.

ALTER TABLE "ships" ADD COLUMN "embarked_at" TIMESTAMPTZ;

-- Default de criação passa de AGENDADO pra EM_OPERACAO.
ALTER TABLE "ships" ALTER COLUMN "status" SET DEFAULT 'EM_OPERACAO';

-- No modelo antigo, EM_OPERACAO/CONCLUIDO significava "embarque já feito"
-- (era o Embarcar que promovia AGENDADO → EM_OPERACAO). Marca esses navios
-- como embarcados pra não reaparecerem como "embarque pendente" na aba.
UPDATE "ships"
SET "embarked_at" = COALESCE("arrival_date"::timestamptz, "created_at")
WHERE "status" IN ('EM_OPERACAO', 'CONCLUIDO');

-- AGENDADO deixa de existir no fluxo: os pendentes viram EM_OPERACAO
-- (sem embarked_at — o embarque deles segue pendente na aba Embarque/Retorno).
UPDATE "ships" SET "status" = 'EM_OPERACAO' WHERE "status" = 'AGENDADO';
