/**
 * SOMENTE LEITURA — não grava nada. Dump da lista de embarque da Equipe Turbo
 * (EQUIPE_4) no navio LEVANTE M, para casar com a lista manual do Josué.
 *
 * Run: npx tsx scripts/dump-turbo-levante.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const ship = await prisma.ship.findFirst({
    where: { name: { contains: "LEVANTE", mode: "insensitive" } },
    select: { id: true, name: true, assigned_team: true, status: true },
  });
  console.log("NAVIO:", JSON.stringify(ship));
  if (!ship) return;

  // Categorias de material (não rancho)
  const KINDS = ["GALPAO", "FLUIDOS", "MAQUINARIO", "FERRAMENTA", "ELETRICA"];
  const mats = await prisma.stockItem.findMany({
    where: { team: { in: KINDS } },
    select: { id: true, name: true, team: true },
  });
  const byId = new Map(mats.map((m) => [m.id, m]));

  const kits = await prisma.embarkKitItem.findMany({
    where: { team: { in: ["EQUIPE_1", "EQUIPE_2", "EQUIPE_4"] } },
    select: { stock_item_id: true, team: true, quantity: true },
  });
  const kitMap = new Map<string, number>();
  for (const k of kits) kitMap.set(`${k.stock_item_id}|${k.team}`, k.quantity);

  const allocs = await prisma.materialTeamAllocation.findMany({
    where: { team: "EQUIPE_4" },
    select: { stock_item_id: true, quantity: true },
  });
  const allocMap = new Map(allocs.map((a) => [a.stock_item_id, a.quantity]));

  const overrides = await prisma.embarkListOverride.findMany({
    where: { ship_id: ship.id },
    select: { stock_item_id: true, team: true, kind: true, quantity: true },
  });
  const ovrMap = new Map(overrides.map((o) => [o.stock_item_id, o]));

  // Itens que aparecem na lista Turbo: tem kit EQUIPE_4 > 0, ou alocação, ou override
  const idSet = new Set<number>();
  for (const k of kits) if (k.team === "EQUIPE_4" && k.quantity > 0) idSet.add(k.stock_item_id);
  for (const a of allocs) idSet.add(a.stock_item_id);
  for (const o of overrides) idSet.add(o.stock_item_id);

  const rows = [...idSet]
    .map((id) => {
      const m = byId.get(id);
      return {
        id,
        name: m?.name ?? `??(${id})`,
        cat: m?.team ?? "?",
        kit1: kitMap.get(`${id}|EQUIPE_1`) ?? 0,
        kit2: kitMap.get(`${id}|EQUIPE_2`) ?? 0,
        kit4: kitMap.get(`${id}|EQUIPE_4`) ?? 0,
        alloc4: allocMap.get(id) ?? 0,
        ovr: ovrMap.get(id)?.quantity ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  console.log(`\n${rows.length} itens na lista Turbo (LEVANTE M)\n`);
  console.log("NAME | CAT | kitE1 | kitE2 | kitTURBO | allocTURBO | overrideNAVIO");
  for (const r of rows) {
    console.log(
      `${r.name} | ${r.cat} | ${r.kit1} | ${r.kit2} | ${r.kit4} | ${r.alloc4} | ${r.ovr ?? "-"}`
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
