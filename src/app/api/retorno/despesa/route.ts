import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import type { Role } from "@/types/database";

const TEAM_LABEL: Record<string, string> = {
  EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3",
};

// POST /api/retorno/despesa — sincroniza a despesa "Material danificado" do
// navio com o retorno confirmado: broken_qty × unit_value de cada item.
//
// Roda no servidor porque unit_value é coluna sensível (o /api/db a esconde de
// quem não é gestão) — quem confirma o retorno nem sempre pode VER o preço,
// mas o prejuízo tem que entrar no custo do navio mesmo assim.
//
// Idempotente por navio+equipe: a despesa é identificada pelo prefixo da
// descrição e ATUALIZADA a cada confirmação (o retorno é editável — a despesa
// acompanha). Quebra zerada na edição remove a despesa. Comida do Rancho tem
// unit_value 0, então naturalmente não soma.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = session.user.role as Role;
  // Mesma permissão de quem confirma o retorno na tela de Embarque/Retorno.
  if (!hasPermission(role, "EMBARQUE", "embarcar")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const actor = session.user.name || session.user.email || "Sistema";

  const body = await request.json().catch(() => null);
  const shipId = typeof body?.ship_id === "string" ? body.ship_id : "";
  const team = typeof body?.team === "string" ? body.team : "";
  if (!shipId || !team) {
    return NextResponse.json({ error: "ship_id e team são obrigatórios" }, { status: 400 });
  }

  const ship = await prisma.ship.findUnique({ where: { id: shipId } });
  if (!ship) return NextResponse.json({ error: "Navio não encontrado" }, { status: 404 });

  // O retorno é único por navio+equipe (a tela edita o mesmo registro).
  const ret = await prisma.materialReturn.findFirst({
    where: { ship_id: shipId, team },
    orderBy: { created_at: "desc" },
    include: { material_return_items: true },
  });
  if (!ret) {
    return NextResponse.json({ error: "Nenhum retorno confirmado para este navio/equipe" }, { status: 404 });
  }

  const broken = ret.material_return_items.filter((it) => it.broken_qty > 0);
  const ids = broken
    .map((it) => it.stock_item_id)
    .filter((x): x is number => x != null);
  const items = ids.length
    ? await prisma.stockItem.findMany({ where: { id: { in: ids } }, select: { id: true, unit_value: true } })
    : [];
  const valueById = new Map(items.map((i) => [i.id, i.unit_value || 0]));

  let total = 0;
  const parts: string[] = [];
  for (const it of broken) {
    const v = it.stock_item_id != null ? valueById.get(it.stock_item_id) || 0 : 0;
    total += v * it.broken_qty;
    parts.push(`${it.broken_qty}× ${it.item_name}`);
  }
  total = Math.round(total * 100) / 100;

  // Prefixo estável = chave do upsert; o resto da descrição lista o que quebrou.
  const marker = `Retorno de material (${TEAM_LABEL[team] || team})`;
  let desc = parts.length ? `${marker}: ${parts.join(", ")}` : marker;
  if (desc.length > 240) desc = `${desc.slice(0, 237)}...`;

  let job = await prisma.job.findFirst({ where: { ship_id: shipId } });

  const existing = job
    ? await prisma.jobAdjustment.findFirst({
        where: { job_id: job.id, category: "MATERIAL_DANIFICADO", description: { startsWith: marker } },
      })
    : null;

  if (total <= 0) {
    // Sem quebra com valor: se havia despesa deste retorno, some com ela.
    if (existing) await prisma.jobAdjustment.delete({ where: { id: existing.id } });
    return NextResponse.json({ amount: 0, removed: !!existing });
  }

  // Navio sem job (não passou pela escalação) ganha um pra receber a despesa —
  // mesmos campos do ensureJob das telas de escalação.
  if (!job) {
    job = await prisma.job.create({
      data: {
        name: ship.name,
        ship_id: ship.id,
        start_date: ship.arrival_date ?? new Date(),
        end_date: ship.departure_date,
        status: "ABERTO",
        port: ship.port,
        created_by: actor,
      },
    });
  }

  const amount = new Prisma.Decimal(total.toFixed(2));
  if (existing) {
    await prisma.jobAdjustment.update({
      where: { id: existing.id },
      data: { amount, description: desc },
    });
  } else {
    await prisma.jobAdjustment.create({
      data: { job_id: job.id, type: "ADICIONAL", category: "MATERIAL_DANIFICADO", description: desc, amount },
    });
  }
  return NextResponse.json({ amount: total, items: parts.length });
}
