-- Forma de cálculo da nota POR CLIENTE (cada cliente fatura de um jeito):
--   DIRETO          — valor fechado digitado na moeda da nota (Continental e
--                     demais): total = soma dos itens, sem conversão.
--   USD_CONVERTIDO  — Wilson Sons: USD por porão/lancha × qtd × taxa negociada
--                     = R$ (débito); ISS do mês abate no crédito.
-- A nota guarda a forma usada na emissão (snapshot) pra memória de cálculo
-- não sair errada no PDF/XLSX se o cadastro mudar depois.
ALTER TABLE "invoice_clients" ADD COLUMN "calc_method" TEXT NOT NULL DEFAULT 'DIRETO';
ALTER TABLE "fiscal_notes" ADD COLUMN "calc_method" TEXT NOT NULL DEFAULT 'DIRETO';

UPDATE "invoice_clients" SET "calc_method" = 'USD_CONVERTIDO' WHERE upper("name") LIKE 'WILSON%';
