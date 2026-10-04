-- Título (cabeçalho) da nota pré-pronto POR CLIENTE, conforme os modelos da
-- diretoria (2- INVOICE/<cliente>):
--   Continental — razão social + caixa "Valor total a Fatura:", sem OI;
--   Wilson Sons — "AO COMANDANTE E/OU ARMADOR DO {NAVIO} A/C WILSON SONS..." +
--                 caixa "Valor", com OI;
--   Deep        — razão social + caixa "Valor".
-- value_label = rótulo da caixa amarela do valor; NULL = padrão do idioma.
ALTER TABLE "invoice_clients" ADD COLUMN "value_label" TEXT;
ALTER TABLE "fiscal_notes" ADD COLUMN "value_label" TEXT;

-- O cadastro da Continental tinha sido sobrescrito por notas de teste (linha
-- do destinatário com lixo, OI marcado, moeda USD): volta ao modelo oficial.
UPDATE "invoice_clients"
   SET "header_line" = NULL, "requires_oi" = false, "default_currency" = 'BRL',
       "value_label" = 'Valor total a Fatura:', "updated_at" = now()
 WHERE "name" = 'Continental';

UPDATE "invoice_clients"
   SET "header_line" = 'AO COMANDANTE E/OU ARMADOR DO {NAVIO} A/C WILSON SONS SHIPPING SERVICES.',
       "requires_oi" = true, "language" = 'EN', "default_currency" = 'BRL',
       "value_label" = 'Valor', "updated_at" = now()
 WHERE "name" = 'Wilson Sons';

UPDATE "invoice_clients"
   SET "header_line" = NULL, "value_label" = 'Valor', "updated_at" = now()
 WHERE "name" = 'Deep';
