// Runner das mensagens agendadas (model ScheduledMessage). Disparado pelo
// scheduler in-process (src/instrumentation.ts) a cada 60s e também pela rota
// manual /api/cron/run-scheduled-messages.
//
// Duas responsabilidades:
//   1. computeNextRun — calcula o próximo disparo (hora/dia local de SP) como
//      instante UTC, usando só Intl (sem lib de data).
//   2. runDueScheduledMessages — pega as agendas vencidas, "reivindica" cada uma
//      de forma atômica (anti-duplo-envio), renderiza o texto com dados ao vivo
//      e envia pro grupo. Um erro numa agenda nunca trava as outras.

import { prisma } from "@/lib/prisma";
import { isEvolutionConfigured, sendWhatsappTextToGroup, extractSentMessageId } from "@/lib/services/evolution-api";
import {
  buildTemplate,
  type ProntidaoTeam,
  type TemplateKind,
} from "@/lib/services/message-templates";

const SP_TZ = "America/Sao_Paulo";

// Offset de SP em minutos no instante `at` (ex.: -180 = UTC-3). Negativo a oeste
// de Greenwich. Compara a "hora local de SP" (via Intl) com o UTC do mesmo
// instante. Recalculado por candidato pra ficar correto se SP voltar a ter DST.
function spOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SP_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // Intl às vezes devolve "24" pra meia-noite
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asIfUtc - at.getTime()) / 60000);
}

// Converte data/hora LOCAL de SP (mo em 1-12) pro instante UTC. Offset
// recalculado no candidato.
function spLocalToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off = spOffsetMinutes(new Date(guessUtc));
  return new Date(guessUtc - off * 60000);
}

// Campos da hora local de SP no instante `at` (dow 0=Dom..6=Sáb).
function spParts(at: Date): { y: number; mo: number; d: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SP_TZ,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get("year")), mo: Number(get("month")), d: Number(get("day")),
    dow: dowMap[get("weekday")] ?? 0,
  };
}

// Soma `n` dias a uma data local de SP e devolve o Y-M-D resultante. Usa meio-dia
// como base (meio-dia ± offset nunca cruza fronteira de dia), evitando bugs de
// virada de mês/ano e de hora inexistente em DST.
function addDaysYmd(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  const noon = spLocalToUtc(y, mo, d, 12, 0);
  const p = spParts(new Date(noon.getTime() + n * 24 * 3600000));
  return { y: p.y, mo: p.mo, d: p.d };
}

export interface ScheduleTiming {
  frequency: "DAILY" | "WEEKLY";
  weekday: number | null;
  hour: number;
  minute: number;
}

// Próxima ocorrência (estritamente futura em relação a `from`) como Date UTC.
export function computeNextRun(s: ScheduleTiming, from: Date): Date {
  const cur = spParts(from);

  if (s.frequency === "DAILY") {
    let cand = spLocalToUtc(cur.y, cur.mo, cur.d, s.hour, s.minute);
    if (cand.getTime() <= from.getTime()) {
      const n = addDaysYmd(cur.y, cur.mo, cur.d, 1);
      cand = spLocalToUtc(n.y, n.mo, n.d, s.hour, s.minute);
    }
    return cand;
  }

  // WEEKLY
  const targetDow = s.weekday ?? 0;
  let delta = (targetDow - cur.dow + 7) % 7;
  if (delta === 0) {
    const todayCand = spLocalToUtc(cur.y, cur.mo, cur.d, s.hour, s.minute);
    if (todayCand.getTime() <= from.getTime()) delta = 7;
  }
  if (delta === 0) return spLocalToUtc(cur.y, cur.mo, cur.d, s.hour, s.minute);
  const n = addDaysYmd(cur.y, cur.mo, cur.d, delta);
  return spLocalToUtc(n.y, n.mo, n.d, s.hour, s.minute);
}

// Monta o texto final: CUSTOM usa body_text; senão renderiza o template ao vivo.
// header_text (quando houver) é prefixado.
async function renderScheduled(s: {
  template: TemplateKind | "CUSTOM";
  team: string | null;
  header_text: string | null;
  body_text: string | null;
}): Promise<string> {
  let core: string;
  if (s.template === "CUSTOM") {
    core = (s.body_text || "").trim();
    if (!core) throw new Error("Agendamento CUSTOM sem corpo (body_text)");
  } else {
    core = await buildTemplate(s.template, (s.team || "ALL") as ProntidaoTeam);
  }
  const header = (s.header_text || "").trim();
  return header ? `${header}\n\n${core}` : core;
}

// Processa todas as agendas vencidas. Retorna um resumo pra logs/rota manual.
export async function runDueScheduledMessages(): Promise<{ claimed: number; sent: number; failed: number }> {
  const now = new Date();
  let claimed = 0, sent = 0, failed = 0;

  // Uma due por vez (claim atômico). Limite de segurança pra nunca loopar
  // infinito caso algo recompute next_run_at no passado.
  for (let i = 0; i < 100; i++) {
    // Entre as vencidas, dispara primeiro a de menor next_run_at; havendo
    // empate (várias no mesmo horário), respeita sort_order (sequência que o
    // usuário definiu) e, por fim, created_at pra ordem estável.
    const due = await prisma.scheduledMessage.findFirst({
      where: { enabled: true, next_run_at: { not: null, lte: now } },
      orderBy: [{ next_run_at: "asc" }, { sort_order: "asc" }, { created_at: "asc" }],
    });
    if (!due || !due.next_run_at) break;

    const nextAfter = computeNextRun(
      { frequency: due.frequency, weekday: due.weekday, hour: due.hour, minute: due.minute },
      now,
    );

    // Claim atômico: avança next_run_at ANTES de enviar, gated pelo valor lido.
    // Um tick concorrente que leu a mesma linha casa 0 aqui e pula → sem duplo
    // envio mesmo com ticks sobrepostos.
    const claim = await prisma.scheduledMessage.updateMany({
      where: { id: due.id, next_run_at: due.next_run_at },
      data: { next_run_at: nextAfter, last_run_at: now },
    });
    if (claim.count === 0) continue;
    claimed++;

    try {
      if (!isEvolutionConfigured()) throw new Error("Evolution API não configurada");
      const text = await renderScheduled(due);
      const sentMsg = await sendWhatsappTextToGroup(due.group_jid, text);
      // Stub pra aparecer em Conversas (não-fatal).
      try {
        await prisma.whatsappMessage.create({
          data: {
            // id REAL do WhatsApp (key.id) → permite "apagar para todos" depois.
            message_id: extractSentMessageId(sentMsg) ?? `scheduled-${due.id}-${Date.now()}`,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: due.group_jid,
            from_me: true,
            push_name: due.group_label,
            message_type: "conversation",
            text,
            timestamp_ms: BigInt(Date.now()),
            sent_by_user_id: due.created_by,
            raw_event: { source: "scheduled", scheduleId: due.id },
          },
        });
      } catch (stubErr) {
        console.warn("[scheduler] stub insert failed:", (stubErr as Error).message);
      }
      await prisma.scheduledMessage.update({ where: { id: due.id }, data: { last_status: "ok" } });
      sent++;
    } catch (err) {
      failed++;
      const msg = `error: ${(err as Error).message}`.slice(0, 300);
      try {
        await prisma.scheduledMessage.update({ where: { id: due.id }, data: { last_status: msg } });
      } catch {
        /* swallow — não deixa um erro de status travar o resto */
      }
      console.warn(`[scheduler] agenda ${due.id} falhou:`, (err as Error).message);
    }
  }

  return { claimed, sent, failed };
}
