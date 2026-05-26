import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappText,
  sendWhatsappTextToGroup,
} from "@/lib/services/evolution-api";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

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
    select: { id: true, name: true, whatsapp_group_jid: true },
  });
  if (!ship) return NextResponse.json({ error: "Navio não encontrado" }, { status: 404 });

  const employees = await prisma.employee.findMany({
    where: { id: { in: body.employeeIds } },
    select: { id: true, name: true, phone: true },
  });

  // ── Build the messages ──────────────────────────────────────────────────
  const isCostado = body.kind === "COSTADO";
  const isPreview = body.mode === "PREVIEW";
  const dateLabel = body.shiftDate ? formatBRDate(body.shiftDate) : "";
  const shiftLabel = body.shiftPeriod ? (SHIFT_LABEL[body.shiftPeriod] || body.shiftPeriod) : "";
  const shipName = ship.name;

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
  const fnByEmployee = new Map<number, string>();
  for (const a of allocations) {
    if (a.employee_id != null && a.job_functions?.name) {
      fnByEmployee.set(a.employee_id, a.job_functions.name);
    }
  }

  function lineFor(emp: { id: number; name: string }): string {
    const fn = fnByEmployee.get(emp.id);
    return fn ? `• ${emp.name} — *${fn}*` : `• ${emp.name}`;
  }
  const namesList = employees.map(lineFor).join("\n");

  const groupMessage = isPreview && isCostado
    ? `🚢 *${shipName}*\n🧹 Operação de limpeza no costado em breve — aguardem instruções.`
    : isCostado
      ? `🚢 *${shipName}*\n📅 Escala da ${shiftLabel} — ${dateLabel}\n\n${namesList}`
      : `🚢 *${shipName}*\n⚓ Equipe escalada para o embarque:\n\n${namesList}`;

  function dmFor(name: string): string {
    if (isPreview && isCostado) {
      return `Olá, ${name}!\n\nAviso prévio: o navio *${shipName}* terá limpeza no costado. Aguarde a escalação com data e turno.\n\n~Equipe Cargo Ships`;
    }
    if (isCostado) {
      return `Olá, ${name}!\n\nVocê foi escalado(a) para o navio *${shipName}* — turno da ${shiftLabel} do dia ${dateLabel}.\n\n~Equipe Cargo Ships`;
    }
    return `Olá, ${name}!\n\nVocê foi escalado(a) para o embarque do navio *${shipName}*.\n\n~Equipe Cargo Ships`;
  }

  const targets: NotifyTargets = body.targets || "BOTH";
  const sendToGroup = targets === "GROUP" || targets === "BOTH";
  const sendToDM = targets === "DM" || targets === "BOTH";

  const results: { target: string; ok: boolean; error?: string }[] = [];

  // ── Group post (only if the ship has a linked group AND the caller asked) ─
  if (sendToGroup) {
    if (ship.whatsapp_group_jid) {
      try {
        await sendWhatsappTextToGroup(ship.whatsapp_group_jid, groupMessage);
        results.push({ target: `grupo:${ship.whatsapp_group_jid}`, ok: true });
        // Espelha a mensagem no histórico do app — sem isso o usuário vê no
        // WhatsApp mas não na aba Conversas.
        try {
          await prisma.whatsappMessage.create({
            data: {
              message_id: `escala-${ship.whatsapp_group_jid}-${Date.now()}`,
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
  }

  // ── Individual DMs ──────────────────────────────────────────────────────
  if (sendToDM) {
    for (const emp of employees) {
      if (!emp.phone || emp.phone.trim().length < 10) {
        results.push({ target: `dm:${emp.name}`, ok: false, error: "sem telefone válido" });
        continue;
      }
      try {
        await sendWhatsappText(emp.phone, dmFor(emp.name));
        results.push({ target: `dm:${emp.name}`, ok: true });
      } catch (err) {
        results.push({ target: `dm:${emp.name}`, ok: false, error: (err as Error).message });
      }
    }
  }

  const sent = results.filter((r) => r.ok).length;
  return NextResponse.json({ status: "ok", sent, total: results.length, results });
}
