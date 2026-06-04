import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeNextRun } from "@/lib/services/scheduler";
import { parseSchedule, type ScheduleInput } from "@/lib/services/scheduled-message";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// GET /api/whatsapp/scheduled — lista todos os agendamentos.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schedules = await prisma.scheduledMessage.findMany({ orderBy: { created_at: "desc" } });
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

  const created = await prisma.scheduledMessage.create({
    data: { ...data, next_run_at, created_by: session.user.id || null },
  });
  return NextResponse.json({ schedule: created }, { status: 201 });
}
