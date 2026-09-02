import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { STOCK_VALUE_ROLES } from "@/lib/rbac";
import { syncRetornoDespesa } from "@/lib/retorno-despesa";
import type { Role } from "@/types/database";

// POST /api/retorno/valor — grava o valor unitário de material DESTE navio
// (ship_material_values), editado na tabela "Retorno de material" do Pagamento
// de Navios. O padrão vem do Almoxarifado (stock_items.unit_value); o que se
// digita aqui vale SÓ pro navio — o estoque e os outros navios não mudam
// (antes a edição sobrescrevia stock_items.unit_value, global).
//
// unit_value null/"" = remove o valor do navio e volta ao padrão do estoque.
// Depois de gravar, re-sincroniza a despesa "Material perdido" de cada equipe
// com retorno no navio — server-side, porque quem edita aqui (Financeiro) nem
// sempre tem a permissão de embarque exigida pelo /api/retorno/despesa.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = session.user.role as Role;
  // Valor de material é dado sensível — mesma régua da coluna unit_value.
  if (!STOCK_VALUE_ROLES.includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const actor = session.user.name || session.user.email || "Sistema";

  const body = await request.json().catch(() => null);
  const shipId = typeof body?.ship_id === "string" ? body.ship_id : "";
  const rawIds: unknown[] = Array.isArray(body?.stock_item_ids) ? body.stock_item_ids : [];
  const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!shipId || ids.length === 0) {
    return NextResponse.json({ error: "ship_id e stock_item_ids são obrigatórios" }, { status: 400 });
  }

  const clear = body?.unit_value == null || body?.unit_value === "";
  const unitValue = Number(body?.unit_value);
  if (!clear && (!Number.isFinite(unitValue) || unitValue < 0)) {
    return NextResponse.json({ error: "unit_value inválido" }, { status: 400 });
  }

  if (clear) {
    await prisma.shipMaterialValue.deleteMany({
      where: { ship_id: shipId, stock_item_id: { in: ids } },
    });
  } else {
    const value = Math.round(unitValue * 100) / 100;
    for (const stockItemId of ids) {
      await prisma.shipMaterialValue.upsert({
        where: { ship_id_stock_item_id: { ship_id: shipId, stock_item_id: stockItemId } },
        update: { unit_value: value, updated_by: actor },
        create: { ship_id: shipId, stock_item_id: stockItemId, unit_value: value, updated_by: actor },
      });
    }
  }

  // Despesa "Material perdido" acompanha o valor novo (idempotente por equipe).
  const returns = await prisma.materialReturn.findMany({
    where: { ship_id: shipId },
    select: { team: true },
    distinct: ["team"],
  });
  for (const r of returns) {
    await syncRetornoDespesa(shipId, r.team, actor).catch(() => null);
  }

  return NextResponse.json({ saved: true, cleared: clear, items: ids.length });
}
