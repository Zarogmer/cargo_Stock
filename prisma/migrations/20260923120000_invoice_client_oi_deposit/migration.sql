-- Cadastro fiscal dos clientes (Financeiro › Dados dos Clientes).
--   requires_oi  — só a Wilson Sons trabalha com OI (ordem de serviço da
--                  agência); o campo OI do modal da nota aparece só pra ela.
--   deposit_bank — dados para depósito impressos na nota deste cliente (a Deep
--                  recebe a conta Santander; em branco = Itaú padrão).
ALTER TABLE "invoice_clients" ADD COLUMN "requires_oi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "invoice_clients" ADD COLUMN "deposit_bank" TEXT;

COMMENT ON COLUMN "invoice_clients"."requires_oi" IS
  'Cliente exige OI (ordem de serviço da agência) na nota — Wilson Sons.';
COMMENT ON COLUMN "invoice_clients"."deposit_bank" IS
  'Dados para depósito da nota, uma linha por informação. NULL = Itaú padrão.';

-- Semente: os clientes das pastas 2- INVOICE da diretoria (dados copiados da
-- última nota emitida de cada um, set/2026). `name` casa com ships.client_name.
INSERT INTO "invoice_clients"
  ("name", "legal_name", "address", "cnpj", "ie", "municipal_reg", "header_line",
   "language", "default_currency", "requires_oi", "deposit_bank", "created_by")
VALUES
  ('Continental',
   'CONTINENTAL VESSELS SERVIÇOS MARÍTIMOS LTDA',
   'Rua: Vereador Henrique Soler, 287 cj 1704 - Ponta da Praia - Santos/SP CEP: 11030-011',
   '45.115.456/0001-35', '132.090.380.110', '301.568-1',
   NULL, 'PT', 'BRL', false, NULL, 'Sistema'),
  ('Wilson Sons',
   'WILSON SONS SHIPPING SERVICES',
   'Av. Ana Costa nº 291 - 9º andar, conj. 92 - Gonzaga - Santos/SP CEP: 11060-001',
   '33.411.794/0011-07', NULL, '18775',
   'AO COMANDANTE E/OU ARMADOR DO {NAVIO} A/C WILSON SONS SHIPPING SERVICES.',
   'EN', 'BRL', true, NULL, 'Sistema'),
  ('Transatlântica',
   'TRANSATLANTICA AFRETAMENTOS E SERVIÇOS MARÍTIMOS LTDA',
   'Rua: Vereador Henrique Soler, 287 cj 901 - Ponta da Praia - Santos/SP CEP: 11030-011',
   '30.694.629/0001-40', '132.090.380.110', '279.763-8',
   NULL, 'PT', 'USD', false, NULL, 'Sistema'),
  ('Naabsa',
   'Agência Marítima Naabsa Ltda.',
   'Av. Ana Costa, 433, sala 184 - Santos/SP CEP: 11060-003',
   '19.790.621/0001-44', NULL, '258.800-9',
   NULL, 'PT', 'USD', false, NULL, 'Sistema'),
  ('Deep',
   'DEEP WATER SERVIÇOS GERAIS E OPERAÇÕES PORTUÁRIAS LTDA.',
   'Rua Bittencourt, 166 - Centro - Santos/SP',
   '06.889.037/0001-07', NULL, NULL,
   NULL, 'PT', 'BRL', false,
   E'SANTANDER 033\nAG: 0002\nC/C: 13008950-4', 'Sistema')
ON CONFLICT ("name") DO UPDATE SET
  "legal_name"       = EXCLUDED."legal_name",
  "address"          = EXCLUDED."address",
  "cnpj"             = EXCLUDED."cnpj",
  "ie"               = EXCLUDED."ie",
  "municipal_reg"    = EXCLUDED."municipal_reg",
  "header_line"      = EXCLUDED."header_line",
  "language"         = EXCLUDED."language",
  "default_currency" = EXCLUDED."default_currency",
  "requires_oi"      = EXCLUDED."requires_oi",
  "deposit_bank"     = EXCLUDED."deposit_bank",
  "updated_at"       = now();
