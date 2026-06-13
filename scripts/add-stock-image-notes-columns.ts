// One-shot: adiciona as colunas `image_url` e `notes` à tabela `stock_items`
// (ADD COLUMN IF NOT EXISTS — idempotente, só adiciona, nunca remove/altera).
// São as colunas que dão suporte a FOTO e OBSERVAÇÃO no inventário do
// Almoxarifado (Estoque / Ferramenta / Elétrica). Ambas nullable (TEXT), então
// é uma mudança aditiva e segura — não mexe em nada existente.
//
// Feito via ALTER cirúrgico em vez de `prisma db push` de propósito: db push
// sincroniza o schema INTEIRO e poderia mexer em outras coisas se houvesse
// drift. Aqui só tocamos nessas duas colunas. O .env aponta pro Postgres de
// PRODUÇÃO no Railway.
//
// Uso:
//   npx tsx scripts/add-stock-image-notes-columns.ts            (dry-run)
//   npx tsx scripts/add-stock-image-notes-columns.ts --apply    (grava)

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function columns(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'stock_items' ORDER BY ordinal_position`,
  );
  return rows.map((r) => r.column_name);
}

async function run() {
  const before = await columns();
  const hasImage = before.includes("image_url");
  const hasNotes = before.includes("notes");
  console.log(`Colunas de stock_items: [${before.join(", ")}]`);
  console.log(`→ image_url: ${hasImage ? "já existe" : "ausente (será adicionada)"}`);
  console.log(`→ notes:     ${hasNotes ? "já existe" : "ausente (será adicionada)"}`);

  if (!APPLY) {
    console.log(`\n[dry-run] Nada gravado. Rode novamente com --apply para aplicar em produção.`);
    return;
  }

  await prisma.$executeRawUnsafe(`ALTER TABLE "stock_items" ADD COLUMN IF NOT EXISTS "image_url" TEXT`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "stock_items" ADD COLUMN IF NOT EXISTS "notes" TEXT`);
  console.log(`\n✅ Colunas garantidas. Novo conjunto: [${(await columns()).join(", ")}]`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
