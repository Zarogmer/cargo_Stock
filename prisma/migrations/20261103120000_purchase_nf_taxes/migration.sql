-- Controle de Compras: colunas fiscais da linha da DANFE (NCM/SH, CST, CFOP,
-- base de cálculo e valor do ICMS, valor do IPI e alíquotas) e o rodapé
-- "CÁLCULO DO IMPOSTO" da nota (produtos, frete, seguro, desconto, outras
-- despesas, IPI, ICMS, total). O Escanear (IA) lia a tabela de itens sem ter
-- onde pôr essas colunas e misturava base/ICMS com quantidade e unitário.
-- Com um campo pra cada coluna, cada valor cai no lugar certo e o usuário
-- confere só quantidade e valor.
ALTER TABLE "purchase_orders" ADD COLUMN "ncm" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "cst" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "cfop" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "icms_base" DOUBLE PRECISION;
ALTER TABLE "purchase_orders" ADD COLUMN "icms_value" DOUBLE PRECISION;
ALTER TABLE "purchase_orders" ADD COLUMN "icms_rate" DOUBLE PRECISION;
ALTER TABLE "purchase_orders" ADD COLUMN "ipi_value" DOUBLE PRECISION;
ALTER TABLE "purchase_orders" ADD COLUMN "ipi_rate" DOUBLE PRECISION;
ALTER TABLE "purchase_orders" ADD COLUMN "nf_totals" JSONB;
