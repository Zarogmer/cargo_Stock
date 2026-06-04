import { NextRequest, NextResponse } from "next/server";
import type { ScheduleFrequency, ScheduleTemplateKind } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeNextRun } from "@/lib/services/scheduler";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

const TEMPLATES: ScheduleTemplateKind[] = ["EPI", "UNIFORME", "PRONTIDAO", "CUSTOM"];
const TEAMS = ["EQUIPE_1", "EQUIPE_2", "EQUIPE_3", "ALL"];
const FREQUENCIES: ScheduleFrequency[] = ["DAILY", "WEEKLY"];

export interface ScheduleInput {
  group_jid?: string;
  group_label?: string | null;
  template?: string;
  team?: string | null;
  header_text?: string | null;
  body_text?: string | null;
  frequency?: string;
  weekday?: number | null;
  hour?: number;
  minute?: number;
  enabled?: boolean;
}

// Valida + normaliza o corpo. Retorna { data } pronto pro create, ou { error }.
// Exportada pra reuso no PATCH (rota [id]).
export function parseSchedule(b: ScheduleInput):
  | { error: string }
  | {
      data: {
        group_jid: string; group_label: string | null;
        template: ScheduleTemplateKind; team: string | null;
        header_text: string | null; body_text: string | null;
        frequency: ScheduleFrequency; weekday: number | null;
        hour: number; minute: number; enabled: boolean;
      };
    } {
  const group_jid = (b.group_jid || "").trim();
  if (!group_jid.endsWith("@g.us")) return { error: "group_jid inválido (precisa ser um grupo @g.us)" };

  const template = (b.template || "") as ScheduleTemplateKind;
  if (!TEMPLATES.includes(template)) return { error: "template inválido" };

  let team: string | null = null;
  if (template === "PRONTIDAO") {
    team = (b.team || "ALL").trim();
    if (!TEAMS.includes(team)) return { error: "team inválido pra PRONTIDAO" };
  }

  const body_text = (b.body_text || "").trim() || null;
  if (template === "CUSTOM" && !body_text) return { error: "body_text é obrigatório no template CUSTOM" };

  const frequency = (b.frequency || "") as ScheduleFrequency;
  if (!FREQUENCIES.includes(frequency)) return { error: "frequency inválida (DAILY ou WEEKLY)" };

  let weekday: number | null = null;
  if (frequency === "WEEKLY") {
    weekday = Number(b.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { error: "weekday inválido (0=Dom..6=Sáb) pra frequência semanal" };
    }
  }

  const hour = Number(b.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { error: "hour inválido (0-23)" };
  const minute = Number(b.minute);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { error: "minute inválido (0-59)" };

  return {
    data: {
      group_jid,
      group_label: (b.group_label || "").trim() || null,
      template,
      team,
      header_text: (b.header_text || "").trim() || null,
      body_text,
      frequency,
      weekday,
      hour,
      minute,
      enabled: b.enabled !== false,
    },
  };
}

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
