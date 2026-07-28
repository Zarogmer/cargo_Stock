-- Observação por item na lista de embarque (aba Embarque, igual à aba Retorno).
-- Guardada no override do par navio+item; item sem ajuste de quantidade também
-- pode ter só a observação (o override passa a existir só por causa dela).
ALTER TABLE "embark_list_overrides" ADD COLUMN "note" TEXT;
