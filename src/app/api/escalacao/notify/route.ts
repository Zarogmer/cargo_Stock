import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappText,
  sendWhatsappTextToGroup,
  extractSentMessageId,
} from "@/lib/services/evolution-api";
import { getTeamGroupJid } from "@/lib/services/team-groups";
import { BOARDING_SAFETY_REMINDER } from "@/lib/services/whatsapp-copy";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// Where to send: "GROUP" only posts to the ship's WhatsApp group (and skips
// DMs entirely), "DM" only sends individual messages to each escalated person,
// "BOTH" does both. Defaults to "BOTH" so older callers keep working.
type NotifyTargets = "GROUP" | "DM" | "BOTH";

interface NotifyBody {
  shipId: string;
  kind: "EMBARQUE" | "COSTADO";
  // Only set for COSTADO
  shiftDate?: string;        // "2026-05-22"
  shiftPeriod?: string;      // "07-13" | "13-19" | "19-01" | "01-07"
  employeeIds: number[];
  targets?: NotifyTargets;
  // PREVIEW (Costado only): grupo já foi criado, ainda não escalou — apenas
  // avisa no privado que vai haver limpeza no costado.
  mode?: "FULL" | "PREVIEW";
}

// Friendlier label for each costado shift — used on the group post so the
// message reads natural ("Escala da tarde: …") instead of just "13-19".
const SHIFT_LABEL: Record<string, string> = {
  "07-13": "manhã (07h–13h)",
  "13-19": "tarde (13h–19h)",
  "19-01": "noite (19h–01h)",
  "01-07": "madrugada (01h–07h)",
};

function formatBRDate(iso: string): string {
  // "2026-05-22" → "22/05/2026"
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

// "2026-05-26T13:00:00.000Z" → "26/05 às 13h00" (horário local de São Paulo).
function formatScheduledBr(d: Date | null | undefined): string | null {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("day")}/${get("month")} às ${get("hour")}h${get("minute")}`;
}

// POST /api/escalacao/notify
// Best-effort: returns 200 with a per-target breakdown so the caller can log
// (or surface) partial failures without blocking the underlying escalação save.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ skipped: "Evolution API não configurada" }, { status: 200 });
  }

  let body: NotifyBody;
  try {
    body = (await request.json()) as NotifyBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (!body.shipId || !body.kind || !Array.isArray(body.employeeIds) || body.employeeIds.length === 0) {
    return NextResponse.json({ error: "Campos obrigatórios faltando" }, { status: 400 });
  }

  const ship = await prisma.ship.findUnique({
    where: { id: body.shipId },
    select: {
      id: true,
      name: true,
      whatsapp_group_jid: true,
      assigned_team: true,
      boarding_situation: true,
      boarding_scheduled_at: true,
    },
  });
  if (!ship) return NextResponse.json({ error: "Navio não encontrado" }, { status: 404 });

  const employees = await prisma.employee.findMany({
    where: { id: { in: body.employeeIds } },
    select: { id: true, name: true, phone: true },
  });
  const phoneByEmployee = new Map<number, string>();
  for (const e of employees) {
    const p = (e.phone || "").trim();
    if (p) phoneByEmployee.set(e.id, p);
  }

  // ── Build the messages ──────────────────────────────────────────────────
  const isCostado = body.kind === "COSTADO";
  const isPreview = body.mode === "PREVIEW";
  const dateLabel = body.shiftDate ? formatBRDate(body.shiftDate) : "";
  const shiftLabel = body.shiftPeriod ? (SHIFT_LABEL[body.shiftPeriod] || body.shiftPeriod) : "";
  const shipName = ship.name;
  // Hoisted pra TypeScript conseguir narrow dentro do closure dmFor — o
  // null-check de ship é feito acima (linha ~97) mas TS perde no escopo.
  const assignedTeam = ship.assigned_team;

  // Cruza com job_allocations ATIVAS desse navio pra incluir a função no
  // texto do grupo (ex.: "• Fulano — WAP"). Pega só o Job do navio.
  const jobsForShip = await prisma.job.findMany({
    where: { ship_id: ship.id },
    select: { id: true },
  });
  const allocations = jobsForShip.length > 0
    ? await prisma.jobAllocation.findMany({
        where: {
          job_id: { in: jobsForShip.map((j) => j.id) },
          status: "ATIVO",
          employee_id: { in: body.employeeIds },
        },
        select: {
          employee_id: true,
          job_functions: { select: { name: true } },
        },
      })
    : [];
  // Um colaborador pode ter mais de uma função no mesmo navio (raro, mas
  // acontece — ex.: AJUDANTE + SUPERVISOR). Agrega todas pra mostrar no texto.
  const fnByEmployee = new Map<number, string[]>();
  for (const a of allocations) {
    if (a.employee_id != null && a.job_functions?.name) {
      const list = fnByEmployee.get(a.employee_id) ?? [];
      if (!list.includes(a.job_functions.name)) list.push(a.job_functions.name);
      fnByEmployee.set(a.employee_id, list);
    }
  }

  // Lista de números (no formato 55DDDxxxxxxxx, sem JID) pra usar como
  // `mentioned` da Evolution. Só é populada no fluxo de Costado — Embarque
  // mantém o formato textual antigo (nome + função).
  const costadoMentions: string[] = [];
  function lineFor(emp: { id: number; name: string }): string {
    if (isCostado) {
      // Costado: marca com @ usando o número (renderiza como contato no
      // WhatsApp + notifica o usuário). Sem função, só @número.
      // Fallback: se não tem telefone, cai no nome cru.
      const phone = phoneByEmployee.get(emp.id);
      if (!phone) return `• ${emp.name}`;
      const digits = phone.replace(/\D/g, "");
      const normalized = digits.startsWith("55") ? digits : `55${digits}`;
      costadoMentions.push(normalized);
      return `• @${normalized}`;
    }
    // Embarque: nome + função(ões). Duas funções saem como "AJUDANTE + SUPERVISOR".
    const fns = fnByEmployee.get(emp.id);
    return fns && fns.length > 0
      ? `• ${emp.name} — *${fns.join(" + ")}*`
      : `• ${emp.name}`;
  }
  const namesList = employees.map(lineFor).join("\n");

  // Embarque: cabeçalho varia conforme a situação cadastrada no navio.
  // Capturo em consts pra ajudar o TS com narrowing (ship já foi validado acima).
  const situation = ship.boarding_situation;
  const scheduledAt = ship.boarding_scheduled_at;
  function embarqueHeader(): string {
    switch (situation) {
      case "VISTORIA":
        return "🔍 Equipe escalada — navio passando por vistoria, aguardem liberação:";
      case "IMEDIATO":
        return "🚨 Equipe escalada — embarque imediato, prontidão total:";
      case "AGENDADO": {
        const when = formatScheduledBr(scheduledAt);
        return when
          ? `🗓️ Equipe escalada — estar no galpão dia ${when} para embarque:`
          : "🗓️ Equipe escalada — embarque agendado, aguardar horário:";
      }
      default:
        return "⚓ Equipe escalada para o embarque:";
    }
  }

  // Embarque: nome do navio NÃO entra na mensagem do grupo (a pedido do RH,
  // pra não vazar info do cliente). Costado continua com o nome porque o grupo
  // é do navio e a mensagem precisa identificar a operação no histórico.
  let groupMessage = isPreview && isCostado
    ? `🚢 *${shipName}*\n🧹 Operação de limpeza no costado em breve — aguardem instruções.`
    : isCostado
      ? `🚢 *${shipName}*\n📅 Escala da ${shiftLabel} — ${dateLabel}\n\n${namesList}`
      : `${embarqueHeader()}\n\n${namesList}`;
  // Aviso de EPI/ISPS Code no fim — só na escalação real (a prévia ainda não
  // pede que ninguém se prepare pra ir).
  if (!isPreview) groupMessage += `\n\n${BOARDING_SAFETY_REMINDER}`;

  function dmFor(emp: { id: number; name: string }): string {
    if (isPreview && isCostado) {
      return `Olá, ${emp.name}!\n\nAviso prévio: o navio *${shipName}* terá limpeza no costado. Aguarde a escalação com data e turno.\n\n~Equipe Cargo Ships`;
    }
    if (isCostado) {
      return `Olá, ${emp.name}!\n\nVocê foi escalado(a) para o navio *${shipName}* — turno da ${shiftLabel} do dia ${dateLabel}.\n\n${BOARDING_SAFETY_REMINDER}\n\n~Equipe Cargo Ships`;
    }
    // Embarque: greeting + "Você foi escalado(a) na Equipe N." + signature.
    // Card #36 pediu "apenas essa frase" mas o #40 reverteu — usuario achou
    // muito direto sem o "Olá" e o "~Equipe Cargo Ships". Mantém o corpo
    // minimalista (sem nome do navio, sem função, sem porto).
    const teamLine = assignedTeam === "EQUIPE_1"
      ? "Você foi escalado(a) na Equipe 1."
      : assignedTeam === "EQUIPE_2"
        ? "Você foi escalado(a) na Equipe 2."
        : "Você foi escalado(a) para o embarque.";
    return `Olá, ${emp.name}!\n\n${teamLine}\n\n${BOARDING_SAFETY_REMINDER}\n\n~Equipe Cargo Ships`;
  }

  const targets: NotifyTargets = body.targets || "BOTH";
  const sendToGroup = targets === "GROUP" || targets === "BOTH";
  const sendToDM = targets === "DM" || targets === "BOTH";

  const results: { target: string; ok: boolean; error?: string }[] = [];

  // ── Group post ──────────────────────────────────────────────────────────
  // EMBARQUE: broadcast pros 2 grupos fixos (Equipe 1 + Equipe 2). Não usa
  // ship.whatsapp_group_jid mesmo se estiver setado — Embarque não tem mais
  // grupo único por navio (mudança feita no fluxo de criação de navio).
  // COSTADO: continua usando ship.whatsapp_group_jid (grupo do próprio navio).
  if (sendToGroup) {
    if (isCostado) {
      if (ship.whatsapp_group_jid) {
        try {
          // Passa as menções (preenchidas em lineFor) pra Evolution marcar
          // cada @numero como mention de verdade no WhatsApp.
          const sent = await sendWhatsappTextToGroup(ship.whatsapp_group_jid, groupMessage, costadoMentions);
          results.push({ target: `grupo:${ship.whatsapp_group_jid}`, ok: true });
          try {
            await prisma.whatsappMessage.create({
              data: {
                // id REAL do WhatsApp (key.id) → permite "apagar para todos" depois.
                message_id: extractSentMessageId(sent) ?? `escala-${ship.whatsapp_group_jid}-${Date.now()}`,
                instance_name: process.env.EVOLUTION_INSTANCE || "default",
                remote_jid: ship.whatsapp_group_jid,
                from_me: true,
                push_name: shipName,
                message_type: "conversation",
                text: groupMessage,
                timestamp_ms: BigInt(Date.now()),
                sent_by_user_id: session.user.id || null,
                raw_event: { source: "escalacao-notify", kind: body.kind, mode: body.mode || "FULL" },
              },
            });
          } catch (stubErr) {
            console.warn("[notify] group stub insert failed:", (stubErr as Error).message);
          }
        } catch (err) {
          results.push({
            target: `grupo:${ship.whatsapp_group_jid}`,
            ok: false,
            error: (err as Error).message,
          });
        }
      } else {
        results.push({ target: "grupo", ok: false, error: "Navio não tem grupo do WhatsApp vinculado" });
      }
    } else {
      // EMBARQUE → manda só pro grupo da equipe designada do navio
      // (assigned_team). Sem equipe definida, pula o envio em grupo — DMs
      // ainda saem normalmente.
      const team = ship.assigned_team === "EQUIPE_1" || ship.assigned_team === "EQUIPE_2"
        ? (ship.assigned_team as "EQUIPE_1" | "EQUIPE_2")
        : null;
      if (!team) {
        results.push({
          target: "grupo-equipe",
          ok: false,
          error: "Equipe designada não informada no navio — defina Equipe 1 ou Equipe 2 pra avisar o grupo.",
        });
      } else {
        const jid = await getTeamGroupJid(team);
        if (!jid) {
          results.push({
            target: `grupo:${team}`,
            ok: false,
            error: `Grupo da ${team === "EQUIPE_1" ? "Equipe 1" : "Equipe 2"} não encontrado (sincronize grupos ou configure WHATSAPP_${team}_JID).`,
          });
        } else {
          try {
            const sent = await sendWhatsappTextToGroup(jid, groupMessage);
            results.push({ target: `grupo:${team}`, ok: true });
            try {
              await prisma.whatsappMessage.create({
                data: {
                  // id REAL do WhatsApp (key.id) → permite "apagar para todos" depois.
                  message_id: extractSentMessageId(sent) ?? `escala-${jid}-${Date.now()}`,
                  instance_name: process.env.EVOLUTION_INSTANCE || "default",
                  remote_jid: jid,
                  from_me: true,
                  push_name: team === "EQUIPE_1" ? "Equipe 1" : "Equipe 2",
                  message_type: "conversation",
                  text: groupMessage,
                  timestamp_ms: BigInt(Date.now()),
                  sent_by_user_id: session.user.id || null,
                  raw_event: { source: "escalacao-notify", kind: body.kind, mode: body.mode || "FULL", team },
                },
              });
            } catch (stubErr) {
              console.warn("[notify] group stub insert failed:", (stubErr as Error).message);
            }
          } catch (err) {
            results.push({
              target: `grupo:${team}`,
              ok: false,
              error: (err as Error).message,
            });
          }
        }
      }
    }
  }

  // ── Individual DMs ──────────────────────────────────────────────────────
  if (sendToDM) {
    for (const emp of employees) {
      if (!emp.phone || emp.phone.trim().length < 10) {
        results.push({ target: `dm:${emp.name}`, ok: false, error: "sem telefone válido" });
        continue;
      }
      try {
        await sendWhatsappText(emp.phone, dmFor(emp));
        results.push({ target: `dm:${emp.name}`, ok: true });
      } catch (err) {
        results.push({ target: `dm:${emp.name}`, ok: false, error: (err as Error).message });
      }
    }
  }

  const sent = results.filter((r) => r.ok).length;
  return NextResponse.json({ status: "ok", sent, total: results.length, results });
}
