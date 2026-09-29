-- Fotos dos relatórios saem do Postgres e vão pro Bucket do Railway (S3).
-- image_data vira opcional (só fotos antigas ainda não migradas) e a foto passa
-- a apontar pro objeto no bucket por storage_key.
ALTER TABLE "ship_report_photos" ALTER COLUMN "image_data" DROP NOT NULL;
ALTER TABLE "ship_report_photos" ADD COLUMN "storage_key" TEXT;
ALTER TABLE "ship_report_photos" ADD COLUMN "mime_type" TEXT NOT NULL DEFAULT 'image/jpeg';
