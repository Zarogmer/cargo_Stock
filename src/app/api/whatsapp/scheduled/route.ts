import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeNextRun } from "@/lib/services/scheduler";
import { parseSchedule, type ScheduleInput } from "@/lib/services/scheduled-message";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "COMERCIAL", "FINANCEIRO"];

// GET /api/whatsapp/scheduled — lista todos os agendamentos.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Ordem da sequência de disparo (sort_order); created_at desempata. Enquanto
  // ninguém reordenou, todos têm sort_order 0 e cai no created_at desc (mais
  // recente no topo, como era antes).
  const schedules = await prisma.scheduledMessage.findMany({
    orderBy: [{ sort_order: "asc" }, { created_at: "desc" }],
  });
  return NextResponse.json({ schedules });
}

// POST /api/whatsapp/scheduled — cria um agendamento.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: ScheduleInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = parseSchedule(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { data } = parsed;
  const next_run_at = data.enabled
    ? computeNextRun({ frequency: data.frequency, weekday: data.weekday, hour: data.hour, minute: data.minute }, new Date())
    : null;

  // Novo agendamento entra no fim da sequência (maior sort_order + 1).
  const agg = await prisma.scheduledMessage.aggregate({ _max: { sort_order: true } });
  const sort_order = (agg._max.sort_order ?? -1) + 1;

  const created = await prisma.scheduledMessage.create({
    data: { ...data, sort_order, next_run_at, created_by: session.user.id || null },
  });
  return NextResponse.json({ schedule: created }, { status: 201 });
}
