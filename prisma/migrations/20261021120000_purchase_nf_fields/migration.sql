-- Controle de Compras: nº da nota fiscal e chave de acesso (44 dígitos) em
-- colunas próprias, pra identificar a nota sem erro na verificação de compra
-- duplicada (dois usuários lançando a mesma NF). Antes a chave ia só dentro
-- da Observação ("NF 123 · chave 4444...") — o backfill abaixo recupera.
ALTER TABLE "purchase_orders" ADD COLUMN "nf_number" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "access_key" TEXT;
CREATE INDEX "purchase_orders_access_key_idx" ON "purchase_orders"("access_key");

UPDATE "purchase_orders"
   SET "access_key" = substring("notes" from 'chave (\d{44})')
 WHERE "access_key" IS NULL AND "notes" ~ 'chave \d{44}';

UPDATE "purchase_orders"
   SET "nf_number" = substring("notes" from 'NF (\d[\d./-]*)')
 WHERE "nf_number" IS NULL AND "notes" ~ '(^|· )NF \d';
