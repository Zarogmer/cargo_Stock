/**
 * Preenche o Rancho (comida) das equipes reais (EQUIPE_1, EQUIPE_2, EQUIPE_4/
 * Turbo) com a quantidade de 1 embarque = o "padrão" (default_quantity) de cada
 * alimento. Só SOBE o estoque: item que já está igual/acima do padrão não é
 * tocado (nunca reduz).
 *
 * Cada ajuste vira um stock_movements do tipo AJUSTE pra ficar no histórico.
 *
 * Materiais NÃO são mexidos aqui (estoque global; fluxo de transferência à parte).
 *
 * Run:  npx tsx scripts/fill-rancho-embarque.ts --dry   (simula, não grava)
 *       npx tsx scripts/fill-rancho-embarque.ts         (grava em PRODUÇÃO)
 *
 * DATABASE_URL aponta pro Postgres de produção (Railway).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

const REAL_TEAMS = ["EQUIPE_1", "EQUIPE_2", "EQUIPE_4"] as const;
const TEAM_LABEL: Record<string, string> = {
  EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_4: "Equipe Turbo",
};
const BY = "Sistema (encher rancho 1 embarque)";

async function main() {
  let totalAjustes = 0;
  for (const team of REAL_TEAMS) {
    const rows = await prisma.stockItem.findMany({
      where: { team },
      select: { id: true, name: true, quantity: true, default_quantity: true },
    });
    // Só os que estão abaixo do padrão e têm padrão > 0.
    const toFill = rows.filter(
      (r) => (r.default_quantity ?? 0) > 0 && (r.quantity ?? 0) < (r.default_quantity ?? 0),
    );
    console.log(`\n${TEAM_LABEL[team]}: ${rows.length} itens · ${toFill.length} a completar.`);
    for (const r of toFill) {
      const delta = +((r.default_quantity ?? 0) - (r.quantity ?? 0)).toFixed(3);
      console.log(`   ${r.name}: ${r.quantity} → ${r.default_quantity}  (+${delta})`);
      if (!DRY) {
        await prisma.stockItem.update({
          where: { id: r.id },
          data: { quantity: r.default_quantity ?? 0, updated_by: BY },
        });
        await prisma.stockMovement.create({
          data: {
            stock_item_id: r.id,
            movement_type: "AJUSTE",
            quantity: delta,
            notes: "Preenchimento do rancho — 1 embarque (padrão)",
            created_by: BY,
          },
        });
      }
      totalAjustes++;
    }
  }
  console.log(
    `\n${DRY ? "[dry-run] " : ""}${totalAjustes} item(ns) ${DRY ? "seriam ajustados" : "ajustados"}.`,
  );
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
