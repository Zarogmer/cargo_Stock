// Validação/normalização do corpo de um agendamento (ScheduledMessage),
// compartilhada entre POST (criar) e PATCH (editar). Fica fora dos route files
// porque o Next só permite exports de handlers (GET/POST/...) num route.ts.

import type { ScheduleFrequency, ScheduleTemplateKind } from "@prisma/client";

const TEMPLATES: ScheduleTemplateKind[] = ["EPI", "UNIFORME", "PRONTIDAO", "COMPRAS", "CUSTOM"];
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

export interface ScheduleData {
  group_jid: string;
  group_label: string | null;
  template: ScheduleTemplateKind;
  team: string | null;
  header_text: string | null;
  body_text: string | null;
  frequency: ScheduleFrequency;
  weekday: number | null;
  hour: number;
  minute: number;
  enabled: boolean;
}

// Retorna { data } pronto pro create/update, ou { error } com a mensagem.
export function parseSchedule(b: ScheduleInput): { error: string } | { data: ScheduleData } {
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
