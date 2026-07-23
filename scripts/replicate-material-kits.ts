/**
 * Replica o KIT DE EMBARQUE nas ALOCAÇÕES das equipes, para todas as categorias
 * de material do Almoxarifado (Utensílios/GALPAO, Fluídos, Maquinário,
 * Ferramenta, Elétrica).
 *
 * Por quê: cada categoria já tem um kit de embarque por equipe (EmbarkKitItem —
 * quanto a Equipe 1/2/Turbo leva de cada item), mas as ALOCAÇÕES
 * (material_team_allocations, o que as abas Equipe 1/2/Turbo mostram como
 * "separado") estavam vazias. Resultado: tudo no Disponível e as equipes zeradas.
 *
 * O que faz: para cada item do kit (EmbarkKitItem com quantity > 0, equipes
 * EQUIPE_1/EQUIPE_2/EQUIPE_4), define a alocação daquela equipe = a quantidade do
 * kit (valor ABSOLUTO). NÃO limita pelo total do item (decisão do usuário): a soma
 * das equipes pode passar do total; o Disponível apenas trava em 0 na tela.
 *
 * Run with:  npx tsx scripts/replicate-material-kits.ts
 *            npx tsx scripts/replicate-material-kits.ts --dry   (não grava)
 *
 * Idempotente: re-rodar deixa as alocações no mesmo valor (kit). Escreve em
 * PRODUÇÃO (DATABASE_URL aponta pro Postgres do Railway).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

// Categorias de material (sentinela em stock_items.team). Rancho fica de fora —
// tem seu próprio modelo.
const KINDS = ["GALPAO", "FLUIDOS", "MAQUINARIO", "FERRAMENTA", "ELETRICA"];
// Equipes que embarcam (mesmas chaves das alocações). EQUIPE_4 = Turbo.
const TEAMS = ["EQUIPE_1", "EQUIPE_2", "EQUIPE_4"];
const ACTOR = "Sistema (replicar kit)";

async function main() {
  console.log(DRY ? "== DRY RUN (não grava) ==" : "== Gravando em PRODUÇÃO ==");
  let grandTotal = 0;

  for (const kind of KINDS) {
    const items = await prisma.stockItem.findMany({ where: { team: kind }, select: { id: true } });
    const ids = items.map((i) => i.id);
    if (ids.length === 0) { console.log(`${kind}: sem itens.`); continue; }

    // Kit de embarque das equipes que embarcam, só o que tem quantidade.
    const kits = await prisma.embarkKitItem.findMany({
      where: { stock_item_id: { in: ids }, team: { in: TEAMS }, quantity: { gt: 0 } },
      select: { stock_item_id: true, team: true, quantity: true },
    });

    const perTeam: Record<string, number> = {};
    for (const k of kits) {
      perTeam[k.team] = (perTeam[k.team] || 0) + 1;
      if (!DRY) {
        // Alocação = quantidade do kit (absoluto). upsert pela unique (item, team).
        await prisma.materialTeamAllocation.upsert({
          where: { stock_item_id_team: { stock_item_id: k.stock_item_id, team: k.team } },
          create: { stock_item_id: k.stock_item_id, team: k.team, quantity: k.quantity, updated_by: ACTOR },
          update: { quantity: k.quantity, updated_by: ACTOR },
        });
      }
    }
    grandTotal += kits.length;
    console.log(`${kind}: ${kits.length} alocações — ${TEAMS.map((t) => `${t}=${perTeam[t] || 0}`).join(", ")}`);
  }

  console.log(`\nTotal de alocações ${DRY ? "que seriam gravadas" : "gravadas"}: ${grandTotal}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
