import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import type { Role } from "@/types/database";

const TEAM_LABEL: Record<string, string> = {
  EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3", EQUIPE_4: "Equipe Turbo",
};

// POST /api/retorno/despesa — sincroniza a despesa "Material perdido" do navio
// com o retorno confirmado: lost_qty × unit_value de cada item.
//
// Só o PERDIDO custa. O avariado (broken_qty) a equipe trouxe de volta — fica
// registrado no retorno e no aviso do WhatsApp, mas não entra no custo do
// navio (regra de 2026-07-21, pedido do Guilherme).
//
// Roda no servidor porque unit_value é coluna sensível (o /api/db a esconde de
// quem não é gestão) — quem confirma o retorno nem sempre pode VER o preço,
// mas o prejuízo tem que entrar no custo do navio mesmo assim.
//
// Idempotente por navio+equipe: a despesa é identificada pelo prefixo da
// descrição e ATUALIZADA a cada confirmação (o retorno é editável — a despesa
// acompanha). Perda zerada na edição remove a despesa. Comida do Rancho tem
// unit_value 0, então naturalmente não soma.
//
// Devolve também `perPerson`: o valor dividido pela equipe do navio, que o
// Pagamento de Navios mostra na coluna "Desc. Geral" de cada colaborador.
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

  const lost = ret.material_return_items.filter((it) => it.lost_qty > 0);
  const ids = lost
    .map((it) => it.stock_item_id)
    .filter((x): x is number => x != null);
  const items = ids.length
    ? await prisma.stockItem.findMany({ where: { id: { in: ids } }, select: { id: true, unit_value: true } })
    : [];
  const valueById = new Map(items.map((i) => [i.id, i.unit_value || 0]));

  let total = 0;
  const parts: string[] = [];
  for (const it of lost) {
    const v = it.stock_item_id != null ? valueById.get(it.stock_item_id) || 0 : 0;
    total += v * it.lost_qty;
    parts.push(`${it.lost_qty}× ${it.item_name}`);
  }
  total = Math.round(total * 100) / 100;

  // Prefixo estável = chave do upsert; o resto da descrição lista o que sumiu.
  const marker = `Retorno de material (${TEAM_LABEL[team] || team})`;
  let desc = parts.length ? `${marker}: ${parts.join(", ")}` : marker;
  if (desc.length > 240) desc = `${desc.slice(0, 237)}...`;

  let job = await prisma.job.findFirst({ where: { ship_id: shipId } });

  // Busca só pelo marcador, SEM filtrar categoria: até 2026-07-21 a despesa
  // nascia como MATERIAL_DANIFICADO (cobrava o quebrado). Assim a linha antiga
  // é reaproveitada/apagada em vez de virar cobrança duplicada.
  const existing = job
    ? await prisma.jobAdjustment.findFirst({
        where: { job_id: job.id, description: { startsWith: marker } },
      })
    : null;

  if (total <= 0) {
    // Nada perdido com valor: se havia despesa deste retorno, some com ela.
    if (existing) await prisma.jobAdjustment.delete({ where: { id: existing.id } });
    return NextResponse.json({ amount: 0, perPerson: 0, removed: !!existing });
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
      data: { amount, description: desc, category: "MATERIAL_PERDIDO" },
    });
  } else {
    await prisma.jobAdjustment.create({
      data: { job_id: job.id, type: "ADICIONAL", category: "MATERIAL_PERDIDO", description: desc, amount },
    });
  }

  // Rateio pela equipe: quem trabalhou no navio (alocações que contam, sem o
  // administrativo, cada pessoa uma vez). Serve só de informação pra tela —
  // o Pagamento de Navios recalcula do mesmo jeito ao renderizar.
  const crew = await prisma.jobAllocation.findMany({
    where: { job_id: job.id, kind: { not: "ADMINISTRATIVO" }, employee_id: { not: null } },
    select: { employee_id: true, status: true, removal_reason: true },
  });
  const people = new Set(
    crew
      .filter((a) => a.status === "ATIVO" || (a.removal_reason || "").startsWith("Navio finalizado"))
      .map((a) => a.employee_id!),
  );
  const perPerson = people.size > 0 ? Math.round((total / people.size) * 100) / 100 : 0;

  return NextResponse.json({ amount: total, perPerson, crew: people.size, items: parts.length });
}
