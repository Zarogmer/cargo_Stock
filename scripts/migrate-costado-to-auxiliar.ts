// Migração: aposenta a função fixa COSTADO e passa o Costado a usar a função
// AUXILIAR OPERACIONAL (com valor por pessoa). Move as alocações do COSTADO para
// AUXILIAR OPERACIONAL MANTENDO o valor (rate) de cada uma, e desativa o COSTADO
// (não apaga — preserva histórico e FKs).
//
// Uso:
//   npx tsx scripts/migrate-costado-to-auxiliar.ts            (DRY RUN — só mostra)
//   npx tsx scripts/migrate-costado-to-auxiliar.ts --apply    (aplica de verdade)
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const costado = await prisma.jobFunction.findFirst({ where: { name: "COSTADO" } });
  const target = await prisma.jobFunction.findFirst({ where: { name: "AUXILIAR OPERACIONAL" } });

  if (!costado) {
    console.log("Função COSTADO não encontrada — nada a migrar.");
    return;
  }
  if (!target) {
    console.log(
      "Função AUXILIAR OPERACIONAL não encontrada. Crie-a na unidade Costado (Financeiro › Valores) antes de migrar.",
    );
    return;
  }

  const total = await prisma.jobAllocation.count({ where: { function_id: costado.id } });

  console.log(`COSTADO #${costado.id} (unit=${costado.unit}) → AUXILIAR OPERACIONAL #${target.id} (unit=${target.unit})`);
  console.log(`Alocações a migrar: ${total}  (o valor/rate de cada uma é MANTIDO)`);
  console.log(`Depois: COSTADO fica DESATIVADA (active=false); AUXILIAR OPERACIONAL vira a função principal do Costado.`);

  if (!APPLY) {
    console.log("\n[DRY RUN] Nada foi alterado. Rode com --apply para aplicar.");
    return;
  }

  const moved = await prisma.jobAllocation.updateMany({
    where: { function_id: costado.id },
    data: { function_id: target.id },
  });
  await prisma.jobFunction.update({ where: { id: costado.id }, data: { active: false } });

  console.log(`\n[APLICADO] ${moved.count} alocações movidas para AUXILIAR OPERACIONAL. COSTADO desativada.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
