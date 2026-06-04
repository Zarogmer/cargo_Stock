import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// PUT /api/whatsapp/scheduled/reorder  — body: { ids: string[] }
//
// Redefine a sequência de disparo: sort_order = posição na lista recebida
// (0, 1, 2, ...). O scheduler usa sort_order pra desempatar agendamentos que
// caem no mesmo horário, então essa ordem vira a ordem de envio.
export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string")
    : null;
  if (!ids || ids.length === 0) {
    return NextResponse.json({ error: "Lista de ids inválida" }, { status: 400 });
  }

  // Atualiza tudo numa transação — sort_order = índice na lista.
  await prisma.$transaction(
    ids.map((id, idx) =>
      prisma.scheduledMessage.updateMany({ where: { id }, data: { sort_order: idx } }),
    ),
  );

  return NextResponse.json({ status: "ok" });
}
