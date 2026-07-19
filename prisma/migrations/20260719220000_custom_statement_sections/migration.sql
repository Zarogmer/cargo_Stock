-- Secoes/subsecoes que o usuario cria na Demonstracao Financeira, alem das
-- fixas da planilha. Titulo referencia com a chave "c<id>" em statement_section.
CREATE TABLE IF NOT EXISTS "custom_statement_sections" (
  "id"          SERIAL PRIMARY KEY,
  "label"       TEXT NOT NULL,
  "group_label" TEXT NOT NULL,
  "sort_order"  INTEGER NOT NULL DEFAULT 0,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "created_by"  TEXT NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
