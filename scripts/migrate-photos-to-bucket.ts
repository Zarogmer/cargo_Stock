/**
 * Migra as fotos dos Relatórios de Bordo que ainda estão inline no Postgres
 * (ship_report_photos.image_data, data URL base64) pro Bucket do Railway
 * (fotos-relatorios) e zera a coluna image_data. Depois roda VACUUM FULL na
 * tabela pra devolver o espaço ao disco (sem isso o Postgres só marca o espaço
 * como livre, e o volume no Railway continua cheio).
 *
 * Precisa de DATABASE_URL e PHOTO_BUCKET_* no ambiente (.env.local aponta pra
 * produção e já tem as credenciais do bucket):
 *
 *   npx tsx --env-file=.env.local scripts/migrate-photos-to-bucket.ts          # só conta
 *   npx tsx --env-file=.env.local scripts/migrate-photos-to-bucket.ts --apply  # migra
 *
 * Pode rodar de novo quantas vezes precisar: só pega foto sem storage_key.
 * Uma foto que falhar no upload fica como está (inline) e é relatada no fim.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const APPLY = process.argv.includes("--apply");
const BATCH = 10;

const prisma = new PrismaClient();

function s3() {
  const { PHOTO_BUCKET, PHOTO_BUCKET_ENDPOINT, PHOTO_BUCKET_ACCESS_KEY_ID, PHOTO_BUCKET_SECRET_ACCESS_KEY } = process.env;
  if (!PHOTO_BUCKET || !PHOTO_BUCKET_ENDPOINT || !PHOTO_BUCKET_ACCESS_KEY_ID || !PHOTO_BUCKET_SECRET_ACCESS_KEY) {
    throw new Error("Faltam as variáveis PHOTO_BUCKET_* (copie da aba Credentials do bucket no Railway pro .env.local)");
  }
  return {
    bucket: PHOTO_BUCKET,
    client: new S3Client({
      region: process.env.PHOTO_BUCKET_REGION || "auto",
      endpoint: PHOTO_BUCKET_ENDPOINT,
      credentials: { accessKeyId: PHOTO_BUCKET_ACCESS_KEY_ID, secretAccessKey: PHOTO_BUCKET_SECRET_ACCESS_KEY },
    }),
  };
}

function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const m = dataUrl.slice(0, comma).match(/^data:(image\/(?:jpeg|jpg|png|webp));base64$/);
  if (!m) return null;
  const mime = m[1] === "image/jpg" ? "image/jpeg" : m[1];
  return { mime, bytes: Buffer.from(dataUrl.slice(comma + 1), "base64") };
}

function keyFor(reportId: string, photoId: number, mime: string) {
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return `relatorios/${reportId}/${photoId}.${ext}`;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const pending = await prisma.shipReportPhoto.findMany({
    where: { storage_key: null, image_data: { not: null } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const [{ bytes }] = await prisma.$queryRaw<{ bytes: bigint }[]>`
    SELECT COALESCE(SUM(LENGTH(image_data)), 0)::bigint AS bytes
    FROM ship_report_photos WHERE storage_key IS NULL AND image_data IS NOT NULL`;
  const [{ size }] = await prisma.$queryRaw<{ size: string }[]>`
    SELECT pg_size_pretty(pg_total_relation_size('ship_report_photos')) AS size`;
  console.log(`Fotos ainda inline no banco: ${pending.length} (${mb(Number(bytes))} de base64; tabela ocupa ${size})`);
  if (!pending.length) {
    if (APPLY) await vacuum();
    return;
  }
  if (!APPLY) {
    console.log("Rode com --apply pra migrar.");
    return;
  }

  const { bucket, client } = s3();
  let ok = 0;
  let sent = 0;
  const failed: { id: number; reason: string }[] = [];

  // Lote a lote pra não puxar centenas de MB de base64 pra memória de uma vez.
  for (let i = 0; i < pending.length; i += BATCH) {
    const ids = pending.slice(i, i + BATCH).map((p) => p.id);
    const rows = await prisma.shipReportPhoto.findMany({
      where: { id: { in: ids } },
      select: { id: true, report_id: true, image_data: true },
    });
    for (const row of rows) {
      const parsed = row.image_data ? parseDataUrl(row.image_data) : null;
      if (!parsed) {
        failed.push({ id: row.id, reason: "data URL inválida" });
        continue;
      }
      const key = keyFor(row.report_id, row.id, parsed.mime);
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: parsed.bytes, ContentType: parsed.mime }));
        await prisma.shipReportPhoto.update({
          where: { id: row.id },
          data: { storage_key: key, mime_type: parsed.mime, image_data: null },
        });
        ok++;
        sent += parsed.bytes.length;
      } catch (err) {
        failed.push({ id: row.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    console.log(`  ${Math.min(i + BATCH, pending.length)}/${pending.length} processadas (${mb(sent)} enviados)`);
  }

  console.log(`\nMigradas: ${ok}  |  Falharam: ${failed.length}`);
  for (const f of failed) console.log(`  foto ${f.id}: ${f.reason}`);

  if (ok) await vacuum();
}

async function vacuum() {
  console.log("\nVACUUM FULL ship_report_photos (devolve o espaço ao disco)...");
  await prisma.$executeRawUnsafe("VACUUM FULL ship_report_photos");
  const [{ size }] = await prisma.$queryRaw<{ size: string }[]>`
    SELECT pg_size_pretty(pg_total_relation_size('ship_report_photos')) AS size`;
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`
    SELECT pg_size_pretty(pg_database_size(current_database())) AS db`;
  console.log(`Tabela agora: ${size}  |  Banco inteiro: ${db}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
