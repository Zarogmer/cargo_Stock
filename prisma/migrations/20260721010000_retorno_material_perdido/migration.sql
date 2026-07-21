-- Retorno de material: separa "avariado" (voltou quebrado — a equipe trouxe de
-- volta, não custa nada ao navio) de "perdido" (não voltou — vira despesa do
-- navio e é dividido pela equipe como Desconto Geral).
ALTER TABLE "material_return_items" ADD COLUMN "lost_qty" INTEGER NOT NULL DEFAULT 0;
