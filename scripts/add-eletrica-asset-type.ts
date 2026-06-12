// One-shot: divide o Maquinário em três tipos no Almoxarifado.
//
// 1) Adiciona o valor ELETRICA ao enum Postgres "AssetType" (idempotente — usa
//    ADD VALUE IF NOT EXISTS). FERRAMENTA e MAQUINARIO já existem; só falta o novo.
//    Sem isso, a aba/destino "Elétrica" dá erro ao gravar em `tools`.
// 2) Reclassifica os "alicates" que entraram como Maquinário para Ferramenta
//    (asset_type MAQUINARIO → FERRAMENTA onde o nome contém "alicate"). Foi o caso
//    relatado: o Kit de Alicates veio como Maquinário e deveria ser Ferramenta.
//
// Roda em DRY-RUN por padrão (só lê e mostra o que mudaria). Passe --apply para
// gravar em produção (o .env aponta pro Postgres de produção no Railway).
//
// Uso:
//   npx tsx scripts/add-eletrica-asset-type.ts            (dry-run)
//   npx tsx scripts/add-eletrica-asset-type.ts --apply    (grava)

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function enumLabels(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
    `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'AssetType'
      ORDER BY e.enumsortorder`,
  );
  return rows.map((r) => r.enumlabel);
}

async function run() {
  const before = await enumLabels();
  const hasEletrica = before.includes("ELETRICA");
  console.log(`Enum AssetType atual: [${before.join(", ")}]`);
  console.log(hasEletrica ? "→ ELETRICA já existe." : "→ ELETRICA ausente (será adicionado).");

  // Alicates ainda marcados como Maquinário (candidatos a virar Ferramenta).
  const alicates = await prisma.tool.findMany({
    where: { asset_type: "MAQUINARIO", name: { contains: "alicate", mode: "insensitive" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  console.log(`\nAlicates como Maquinário: ${alicates.length}`);
  for (const t of alicates) console.log(`  - #${t.id} "${t.name}"`);

  if (!APPLY) {
    console.log(`\n[dry-run] Nada gravado. Rode novamente com --apply para aplicar em produção.`);
    return;
  }

  if (!hasEletrica) {
    await prisma.$executeRawUnsafe(`ALTER TYPE "AssetType" ADD VALUE IF NOT EXISTS 'ELETRICA'`);
    console.log(`\n✅ ELETRICA adicionado ao enum AssetType. Novo: [${(await enumLabels()).join(", ")}]`);
  }

  if (alicates.length > 0) {
    const res = await prisma.tool.updateMany({
      where: { asset_type: "MAQUINARIO", name: { contains: "alicate", mode: "insensitive" } },
      data: { asset_type: "FERRAMENTA", updated_by: "Sistema" },
    });
    console.log(`✅ ${res.count} item(ns) movido(s) de Maquinário → Ferramenta.`);
  }
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
