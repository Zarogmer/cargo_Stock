// One-off: recria o retorno de material do MV EUROPAN GRAECA (Equipe 2) a
// partir do aviso de WhatsApp de 10/09/2026, espelhando handleSaveReturn.
import { PrismaClient } from "@prisma/client";
import { syncRetornoDespesa } from "../src/lib/retorno-despesa";
const prisma = new PrismaClient();
const SHIP_ID = "acc5a531-87e2-42c4-9a23-1788598e5280";
const SHIP_NAME = "MV EUROPAN GRAECA";
const TEAM = "EQUIPE_2";
const ACTOR = "Josué";
const DAY = new Date("2026-09-10T00:00:00.000Z");
const AT = new Date("2026-09-10T13:18:00.000Z");
// name, stock_item_id, went (lista do embarque), consumed, broken
const ITEMS: Array<[string, number, number, number, number]> = [
  ["ESPUMA", 318, 3, 1, 0],
  ["QUIMICA KIMIKLAP", 598, 14, 9, 0],
  ["NIPLE", 445, 18, 3, 0],
  ["LUVA PVC", 321, 12, 6, 0],
  ["LUVA PIGMENTADA BRANCA", 323, 60, 60, 0],
  ["SILVER TAPE", 326, 6, 3, 0],
  ["FITA VERMELHA", 327, 1, 1, 0],
  ["FITA HELLERMAN/LACRE", 483, 1, 1, 0],
  ["DESINGRIPANTE", 334, 2, 1, 0],
  ["MASCARA DE PROT SIMPLES", 347, 16, 3, 0],
  ["MANGUEIRA MEDIA", 443, 30, 0, 2],
  ["MANGUEIRA FINA", 442, 30, 0, 1],
];
(async () => {
  const dry = process.argv.includes("--dry");
  const existing = await prisma.materialReturn.findFirst({ where: { ship_id: SHIP_ID, team: TEAM } });
  if (existing) { console.log("Já existe retorno", existing.id, "— nada feito."); await prisma.$disconnect(); return; }
  const ids = ITEMS.map((i) => i[1]);
  const stock = await prisma.stockItem.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, quantity: true } });
  const tag = `${SHIP_NAME} (${TEAM})`;
  const movs = await prisma.stockMovement.findMany({ where: { stock_item_id: { in: ids }, notes: { startsWith: "Embarque" } }, select: { stock_item_id: true, notes: true } });
  const embarked = new Set(movs.filter((m) => (m.notes || "").includes(tag)).map((m) => m.stock_item_id));
  for (const [name, id] of ITEMS) {
    const s = stock.find((x) => x.id === id);
    if (!s || s.name !== name) throw new Error(`Item ${name} #${id} não bate com o estoque: ${JSON.stringify(s)}`);
  }
  console.log("embarcados (só AJUSTE):", [...embarked]);
  if (dry) { console.log("DRY RUN — nada gravado"); await prisma.$disconnect(); return; }

  const ret = await prisma.$transaction(async (tx) => {
    const ret = await tx.materialReturn.create({
      data: {
        ship_id: SHIP_ID, team: TEAM, notes: null, created_by: ACTOR, created_at: AT,
        material_return_items: {
          create: ITEMS.map(([name, id, went, consumed, broken]) => ({
            stock_item_id: id, item_name: name, went_qty: went, returned_qty: 0,
            broken_qty: broken, lost_qty: 0, consumed_qty: consumed, note: null,
          })),
        },
      },
    });
    for (const [name, id, , consumed, broken] of ITEMS) {
      const s = stock.find((x) => x.id === id)!;
      let delta = 0;
      for (const [qty, label] of [[broken, "Avaria"], [consumed, "Insumo"]] as Array<[number, string]>) {
        if (qty <= 0) continue;
        if (embarked.has(id)) {
          await tx.stockMovement.create({ data: { stock_item_id: id, movement_type: "AJUSTE", quantity: qty, movement_date: DAY, notes: `${label}: ${tag} — a baixa já foi no embarque`, created_by: ACTOR, created_at: AT } });
        } else {
          await tx.stockMovement.create({ data: { stock_item_id: id, movement_type: "BAIXA", quantity: qty, movement_date: DAY, notes: `${label}: ${tag}`, created_by: ACTOR, created_at: AT } });
          delta += qty;
        }
      }
      if (delta > 0) {
        const newQty = Math.max(0, s.quantity - delta);
        await tx.stockItem.update({ where: { id }, data: { quantity: newQty, updated_by: ACTOR } });
        console.log(`  ${name}: estoque ${s.quantity} → ${newQty}`);
      } else {
        console.log(`  ${name}: só registro (baixa já foi no embarque)`);
      }
    }
    return ret;
  // Banco remoto (Railway) + ~25 gravações em sequência passam fácil dos 5s
  // padrão da transação interativa (P2028 em 23/09/2026) — dá folga.
  }, { timeout: 180_000, maxWait: 30_000 });
  console.log("Retorno criado id", ret.id);
  const sync = await syncRetornoDespesa(SHIP_ID, TEAM, ACTOR);
  console.log("syncRetornoDespesa:", JSON.stringify(sync));
  await prisma.$disconnect();
})().catch(async (e) => { console.error("ERRO", e); await prisma.$disconnect(); process.exit(1); });
