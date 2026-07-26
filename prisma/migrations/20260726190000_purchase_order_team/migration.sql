-- Equipe (opcional) da compra: pra qual equipe o material foi comprado.
-- Ao lançar no Almoxarifado, a quantidade é alocada direto pra essa equipe.
ALTER TABLE "purchase_orders" ADD COLUMN "team" TEXT;
