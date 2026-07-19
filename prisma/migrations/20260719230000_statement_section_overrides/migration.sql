-- Renomeia uma secao FIXA da Demonstracao Financeira sem tocar no dado: a chave
-- (ex.: "6.1", "9.2", "12") continua a mesma nos titulos; so o rotulo exibido no
-- filtro e no cabecalho passa a vir daqui. Sem linha = usa o rotulo padrao.
CREATE TABLE IF NOT EXISTS "statement_section_overrides" (
  "id"          SERIAL PRIMARY KEY,
  "section_key" TEXT NOT NULL UNIQUE,
  "label"       TEXT NOT NULL,
  "created_by"  TEXT NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
