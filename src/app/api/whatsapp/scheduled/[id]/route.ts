import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeNextRun } from "@/lib/services/scheduler";
import { parseSchedule, type ScheduleInput } from "@/lib/services/scheduled-message";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "COMERCIAL", "FINANCEIRO"];

async function guard() {
  const session = await auth();
  if (!session?.user) return { error: "Unauthorized", status: 401 as const };
  if (!ALLOWED_ROLES.includes(session.user.role)) return { error: "Forbidden", status: 403 as const };
  return { session };
}

// PATCH /api/whatsapp/scheduled/[id] — edita ou liga/desliga um agendamento.
// Recalcula next_run_at sempre (próxima ocorrência futura); desabilitar zera.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });

  const { id } = await params;
  const existing = await prisma.scheduledMessage.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Agendamento não encontrado" }, { status: 404 });

  let body: ScheduleInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  // Mescla o que veio com o que já existe e re-valida o conjunto completo.
  const merged: ScheduleInput = {
    group_jid: body.group_jid ?? existing.group_jid,
    group_label: body.group_label ?? existing.group_label,
    template: body.template ?? existing.template,
    team: body.team ?? existing.team,
    header_text: body.header_text ?? existing.header_text,
    body_text: body.body_text ?? existing.body_text,
    frequency: body.frequency ?? existing.frequency,
    weekday: body.weekday ?? existing.weekday,
    hour: body.hour ?? existing.hour,
    minute: body.minute ?? existing.minute,
    enabled: body.enabled ?? existing.enabled,
  };

  const parsed = parseSchedule(merged);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { data } = parsed;
  const next_run_at = data.enabled
    ? computeNextRun({ frequency: data.frequency, weekday: data.weekday, hour: data.hour, minute: data.minute }, new Date())
    : null;

  const updated = await prisma.scheduledMessage.update({
    where: { id },
    data: { ...data, next_run_at },
  });
  return NextResponse.json({ schedule: updated });
}

// DELETE /api/whatsapp/scheduled/[id]
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });

  const { id } = await params;
  try {
    await prisma.scheduledMessage.delete({ where: { id } });
  } catch {
    return NextResponse.json({ error: "Agendamento não encontrado" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
