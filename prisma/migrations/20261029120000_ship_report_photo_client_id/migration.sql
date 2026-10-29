-- Relatórios de Bordo offline: a foto tirada sem internet nasce no celular com
-- um UUID (client_id) e entra na fila de sincronização. Se o mesmo envio chegar
-- duas vezes (rede caiu depois do servidor gravar, celular reenviou), o UNIQUE
-- impede a duplicata e a API devolve a foto que já existe.
ALTER TABLE "ship_report_photos" ADD COLUMN "client_id" TEXT;
CREATE UNIQUE INDEX "ship_report_photos_client_id_key" ON "ship_report_photos"("client_id");
