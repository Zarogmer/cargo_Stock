-- Valor unitário (R$) dos itens do Almoxarifado.
-- Visível só para os papéis em STOCK_VALUE_ROLES (src/lib/rbac.ts); a coluna é
-- filtrada na resposta do /api/db, não apenas escondida na interface.
-- Rancho compartilha a tabela stock_items mas não exibe/edita o valor.
ALTER TABLE "stock_items" ADD COLUMN "unit_value" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "epis" ADD COLUMN "unit_value" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "uniforms" ADD COLUMN "unit_value" DOUBLE PRECISION NOT NULL DEFAULT 0;
