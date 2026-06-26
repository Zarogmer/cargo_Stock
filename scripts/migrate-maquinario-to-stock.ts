// One-shot: migra o MAQUINÁRIO do modelo de EMPRÉSTIMO (tabela `tools`,
// asset_type=MAQUINARIO) para o modelo de INVENTÁRIO (tabela `stock_items`, com
// o campo `team="MAQUINARIO"` como sentinela do setor) — igual já foi feito com
// Ferramenta e Elétrica (ver migrate-tools-to-stock.ts).
//
// Cada máquina é única (Máquina 1, 2, 3...), então NÃO agregamos por nome: cada
// linha de `tools` vira 1 item de estoque com quantity=1, preservando onde está:
//   status DISPONIVEL → assigned_team DISPONIVEL
//   status EQUIPE_1    → assigned_team EQUIPE_1
//   status EQUIPE_2    → assigned_team EQUIPE_2
//   status MANUTENCAO  → assigned_team DISPONIVEL (sem "manutenção" no inventário;
//                        anota "[Manutenção]" em notes)
// notes da máquina são preservadas em stock_items.notes.
//
// Roda em DRY-RUN por padrão. O .env aponta pro Postgres de PRODUÇÃO no Railway.
//
// Uso:
//   npx tsx scripts/migrate-maquinario-to-stock.ts            (dry-run)
//   npx tsx scripts/migrate-maquinario-to-stock.ts --apply    (grava)
//   npx tsx scripts/migrate-maquinario-to-stock.ts --apply --force  (mesmo com itens já existentes)

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

const TEAM = "MAQUINARIO";

function assignFromStatus(status: string): { assigned: string; manut: boolean } {
  switch (status) {
    case "EQUIPE_1": return { assigned: "EQUIPE_1", manut: false };
    case "EQUIPE_2": return { assigned: "EQUIPE_2", manut: false };
    case "MANUTENCAO": return { assigned: "DISPONIVEL", manut: true };
    default: return { assigned: "DISPONIVEL", manut: false };
  }
}

async function run() {
  // Anti-duplicação: se já há itens de inventário em MAQUINARIO, a migração
  // provavelmente já rodou. Exige --force pra seguir.
  const already = await prisma.stockItem.count({ where: { team: TEAM } });
  if (already > 0) {
    console.log(`⚠️  Já existem ${already} item(ns) em stock_items com team=MAQUINARIO.`);
    if (!FORCE) {
      console.log("→ Para evitar duplicar, abortado. Rode com --force se tiver certeza.\n");
      return;
    }
    console.log("→ --force: seguindo mesmo assim.\n");
  }

  const tools = await prisma.tool.findMany({
    where: { asset_type: "MAQUINARIO" },
    select: { name: true, status: true, location: true, notes: true },
    orderBy: { name: "asc" },
  });

  if (tools.length === 0) {
    console.log("Nenhum maquinário em `tools` para migrar. Nada a fazer.");
    return;
  }

  console.log(`Linhas em \`tools\` (Maquinário): ${tools.length}\n`);
  console.log(`── MAQUINARIO (${tools.length} item(ns)) ─────────────────────────────`);
  for (const t of tools) {
    const { assigned, manut } = assignFromStatus(t.status);
    const noteParts = [manut ? "[Manutenção]" : "", t.notes?.trim() || ""].filter(Boolean);
    const note = noteParts.length ? `  📝 ${noteParts.join(" | ")}` : "";
    console.log(`  • ${t.name}  → ${assigned}${note}`);
  }
  console.log("");

  if (!APPLY) {
    console.log("[dry-run] Nada gravado. Rode novamente com --apply para aplicar em produção.");
    return;
  }

  // 1) Cria os itens de inventário (quantity=1 por máquina).
  let created = 0;
  for (const t of tools) {
    const { assigned, manut } = assignFromStatus(t.status);
    const noteParts = [manut ? "[Manutenção]" : "", t.notes?.trim() || ""].filter(Boolean);
    await prisma.stockItem.create({
      data: {
        name: t.name,
        location: t.location?.trim() || null,
        quantity: 1,
        default_quantity: 0,
        category: "OUTROS",
        unit: "UN",
        team: TEAM,
        assigned_team: assigned,
        min_quantity: 0,
        notes: noteParts.length ? noteParts.join(" | ") : null,
        updated_by: "Migração maquinário→stock",
      },
    });
    created += 1;
  }
  console.log(`✅ ${created} item(ns) criado(s) em stock_items (team=MAQUINARIO).`);

  // 2) Remove as linhas migradas de `tools` (cascade apaga tool_movements delas).
  const del = await prisma.tool.deleteMany({ where: { asset_type: "MAQUINARIO" } });
  console.log(`🗑️  ${del.count} linha(s) removida(s) de \`tools\` (Maquinário).`);
  console.log("\n✅ Migração concluída.");
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
