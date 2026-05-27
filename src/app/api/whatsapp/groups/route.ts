import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createWhatsappGroup,
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  setWhatsappGroupDescription,
  updateGroupParticipants,
} from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";
import { getTeamGroupJids } from "@/lib/services/team-groups";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// Mapeia código de serviço pro nome amigável (precisa bater com a UI de Navios).
const SERVICE_LABELS: Record<string, string> = {
  LAVAGEM_PORAO: "Lavagem de Porão",
  PINTURA: "Pintura",
  RASPAGEM: "Raspagem",
  COSTADO: "Costado",
};

const TEAM_LABELS: Record<string, string> = {
  EQUIPE_1: "Equipe 1",
  EQUIPE_2: "Equipe 2",
};

// "2026-05-26T13:00:00.000Z" → "26/05 às 13h00". Usa horário local de São Paulo
// pra evitar confusão com UTC — o operador no galpão raciocina em horário local.
function formatScheduledBr(d: Date | null | undefined): string | null {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  });
  // Output ex: "26/05/2026 13:00" — quebro em data + hora pra ler natural.
  const parts = fmt.formatToParts(dt);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const day = get("day"), month = get("month");
  const hour = get("hour"), minute = get("minute");
  return `${day}/${month} às ${hour}h${minute}`;
}

// Linha de cabeçalho que muda conforme a situação do embarque.
// Retorna null se não houver situação informada (fallback genérico).
function situationLine(
  situation: string | null | undefined,
  scheduledAt: Date | null | undefined,
): string | null {
  switch (situation) {
    case "VISTORIA":
      return "🔍 *Situação:* Navio passando por vistoria — aguardem liberação.";
    case "IMEDIATO":
      return "🚨 *Situação:* Embarque imediato — prontidão total.";
    case "AGENDADO": {
      const when = formatScheduledBr(scheduledAt);
      return when
        ? `🗓️ *Situação:* Embarque agendado — estar no galpão dia ${when}.`
        : "🗓️ *Situação:* Embarque agendado — aguardar horário definido pela supervisão.";
    }
    default:
      return null;
  }
}

// Monta a mensagem inicial que vai pro grupo logo após criar o grupo,
// avisando os funcionários sobre a operação (data, produto, serviços, porto, etc.).
// Retorna duas variantes: `description` (só info, vira descrição do grupo) e
// `message` (info + assinatura "Aguardem...", vai como mensagem no chat).
//
// `includeShipName` controla se o nome do navio entra no texto. Em grupos
// criados por navio (Costado) o nome já está no título do grupo, então é
// redundante. Em broadcast pros grupos fixos Equipe 1/Equipe 2 (Embarque),
// o nome é essencial pra contextualizar a mensagem.
function buildShipWelcomeMessage(ship: {
  name: string;
  arrival_date: Date | null;
  departure_date: Date | null;
  port: string | null;
  cargo_type: string | null;
  holds_count: number | null;
  services: string[];
  assigned_team: string | null;
  boarding_situation: string | null;
  boarding_scheduled_at: Date | null;
}, opts: { includeShipName?: boolean } = {}): { description: string; message: string } {
  const isCostado = ship.services.includes("COSTADO");
  const opType = isCostado ? "COSTADO" : "EMBARQUE";
  const opEmoji = isCostado ? "🛟" : "⚓";

  const lines: string[] = [];
  lines.push(`📢 *NOVA OPERAÇÃO — ${opType}* ${opEmoji}`);
  lines.push("");

  if (opts.includeShipName) {
    lines.push(`🚢 *Navio:* ${ship.name}`);
  }

  // Situação só faz sentido pra EMBARQUE — Costado tem fluxo próprio (Escalação > Costado).
  if (!isCostado) {
    const sit = situationLine(ship.boarding_situation, ship.boarding_scheduled_at);
    if (sit) lines.push(sit);
  }

  // Chegada/Saída, Produto e Navio (nome em grupos do navio) foram retirados
  // a pedido do RH — a mensagem fica focada no que o funcionário precisa
  // saber pra executar o serviço (situação, local, porões, serviços, equipe).
  if (ship.port) lines.push(`📍 *Local:* ${ship.port}`);
  if (ship.holds_count != null) lines.push(`🕳️ *Porões:* ${ship.holds_count}`);

  if (!isCostado) {
    const subs = ship.services.filter((s) => s !== "COSTADO");
    if (subs.length > 0) {
      const labels = subs.map((s) => SERVICE_LABELS[s] || s).join(", ");
      lines.push(`🔧 *Serviços:* ${labels}`);
    }
  } else {
    lines.push(`🔧 *Serviço:* Costado`);
  }

  // Cliente fica fora do texto: os funcionários não precisam dessa informação.
  if (ship.assigned_team) {
    lines.push(`👥 *Equipe:* ${TEAM_LABELS[ship.assigned_team] || ship.assigned_team}`);
  }

  const description = lines.join("\n");
  const message = `${description}\n\n_Aguardem instruções da supervisão. Bom trabalho! 🚀_`;
  return { description, message };
}

// Embarque: manda a mensagem inicial pros 2 grupos fixos (Equipe 1 + Equipe 2)
// em vez de criar um grupo novo por navio. Os grupos já existem no WhatsApp
// e foram cadastrados antes (a resolução do JID é feita pelo helper
// team-groups, com fallback automático via push_name).
//
// Comportamento:
//   • Não cria grupo nenhum.
//   • Não altera Ship.whatsapp_group_jid (não há grupo único por navio).
//   • Não muda descrição dos grupos das equipes (elas são fixas).
//   • Persiste a mensagem em `whatsapp_messages` pra aparecer em Conversas.
async function broadcastEmbarqueToTeams(args: {
  shipId: string;
  employeeIds: number[];
  sentByUserId: string | null;
}): Promise<NextResponse> {
  const { shipId, sentByUserId } = args;

  const ship = await prisma.ship.findUnique({
    where: { id: shipId },
    select: {
      name: true,
      arrival_date: true,
      departure_date: true,
      port: true,
      cargo_type: true,
      holds_count: true,
      services: true,
      assigned_team: true,
      boarding_situation: true,
      boarding_scheduled_at: true,
    },
  });
  if (!ship) return NextResponse.json({ error: "Navio não encontrado" }, { status: 404 });

  const jids = await getTeamGroupJids();
  const targets: { team: "EQUIPE_1" | "EQUIPE_2"; jid: string }[] = [];
  if (jids.EQUIPE_1) targets.push({ team: "EQUIPE_1", jid: jids.EQUIPE_1 });
  if (jids.EQUIPE_2) targets.push({ team: "EQUIPE_2", jid: jids.EQUIPE_2 });

  if (targets.length === 0) {
    return NextResponse.json({
      status: "partial",
      warning: "Nenhum grupo de equipe encontrado. Configure WHATSAPP_EQUIPE_1_JID/WHATSAPP_EQUIPE_2_JID ou sincronize grupos com nome 'Equipe 1' e 'Equipe 2'.",
    });
  }

  // Inclui o nome do navio na mensagem — em grupo fixo de equipe, o título
  // do grupo não diz qual navio é, então o nome precisa estar no corpo.
  const { message } = buildShipWelcomeMessage(ship, { includeShipName: true });
  const instance = process.env.EVOLUTION_INSTANCE || "default";

  const results: { team: string; jid: string; ok: boolean; error?: string }[] = [];
  for (const { team, jid } of targets) {
    try {
      await sendWhatsappTextToGroup(jid, message);
      results.push({ team, jid, ok: true });
      try {
        await prisma.whatsappMessage.create({
          data: {
            message_id: `embarque-broadcast-${jid}-${Date.now()}`,
            instance_name: instance,
            remote_jid: jid,
            from_me: true,
            push_name: team === "EQUIPE_1" ? "Equipe 1" : "Equipe 2",
            message_type: "conversation",
            text: message,
            timestamp_ms: BigInt(Date.now()),
            sent_by_user_id: sentByUserId,
            raw_event: { source: "embarque-broadcast", shipId, team },
          },
        });
      } catch (stubErr) {
        console.warn("[groups] broadcast stub insert failed:", (stubErr as Error).message);
      }
    } catch (err) {
      results.push({ team, jid, ok: false, error: (err as Error).message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length === results.length) {
    return NextResponse.json({
      status: "partial",
      warning: `Falha ao enviar pros grupos das equipes: ${failed[0].error}`,
      results,
    });
  }
  return NextResponse.json({
    status: failed.length > 0 ? "partial" : "ok",
    broadcast: true,
    targets: results,
    ...(failed.length > 0 && {
      warning: `${failed.length} grupo(s) falharam: ${failed.map((f) => `${f.team} (${f.error})`).join(", ")}`,
    }),
  });
}

// POST /api/whatsapp/groups
//
// Dois modos:
//
// 1) `mode: "CREATE"` (default) — cria um grupo novo no WhatsApp.
//    Body: { subject, participants, shipId?, employeeIds? }
//    Usado por Costado: cria grupo do navio e linka em Ship.whatsapp_group_jid.
//
// 2) `mode: "BROADCAST_TEAMS"` — não cria grupo nenhum. Manda a mensagem
//    inicial de operação pros 2 grupos fixos (Equipe 1 e Equipe 2) que
//    já existem no WhatsApp. Usado por Embarque.
//    Body: { mode: "BROADCAST_TEAMS", shipId, employeeIds? }
//    Não mexe em Ship.whatsapp_group_jid (não há um grupo único por navio).
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }

  let body: { mode?: string; subject?: string; participants?: string[]; shipId?: string; employeeIds?: number[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const mode = (body.mode || "CREATE") as "CREATE" | "BROADCAST_TEAMS";
  const subject = body.subject?.trim();
  const participants = Array.isArray(body.participants) ? body.participants : [];
  const shipId = body.shipId?.trim() || null;
  // IDs dos colaboradores que o usuário selecionou no app. Guardamos no stub
  // pra usar como fonte da verdade nos "Dados do grupo" — o WhatsApp moderno
  // expõe LIDs opacos (não-telefone) nos participantes, então não dá pra
  // confiar só no mapeamento por phone.
  const employeeIds = Array.isArray(body.employeeIds)
    ? body.employeeIds.filter((n): n is number => typeof n === "number")
    : [];

  if (mode === "BROADCAST_TEAMS") {
    if (!shipId) {
      return NextResponse.json({ error: "shipId é obrigatório no modo BROADCAST_TEAMS" }, { status: 400 });
    }
    return broadcastEmbarqueToTeams({
      shipId,
      employeeIds,
      sentByUserId: session.user.id || null,
    });
  }

  if (!subject) return NextResponse.json({ error: "Nome do grupo é obrigatório" }, { status: 400 });
  if (participants.length === 0) {
    return NextResponse.json({ error: "Selecione ao menos um participante" }, { status: 400 });
  }

  try {
    const created = await createWhatsappGroup(subject, participants);
    // Evolution returns the JID in different shapes depending on version; cover both.
    const jid = (created.id || created.groupJid || "") as string;

    // Insert a "systemNotice" stub so the group shows up in the Conversas list
    // immediately — without it the conversation only materializes once someone
    // actually sends a message in the group. push_name carries the subject so
    // the list can label the group properly (see conversations route SQL).
    if (jid) {
      try {
        await prisma.whatsappMessage.create({
          data: {
            message_id: `system-create-${jid}-${Date.now()}`,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: jid,
            from_me: true,
            push_name: subject,
            message_type: "systemNotice",
            text: "✨ Grupo criado",
            timestamp_ms: BigInt(Date.now()),
            sent_by_user_id: session.user.id || null,
            raw_event: {
              source: "groups-create",
              subject,
              participants_count: participants.length,
              // Lista canônica de quem foi convidado pelo app. O GET dos dados
              // do grupo lê isso pra mostrar nomes em vez de LIDs opacos.
              employee_ids: employeeIds,
            },
          },
        });
      } catch (stubErr) {
        // Non-fatal: the group exists on WhatsApp regardless. The user can use
        // "Sincronizar grupos" to backfill later.
        console.warn("[groups] stub insert failed:", (stubErr as Error).message);
      }
    }

    // Promove pra admin do grupo todos os colaboradores selecionados que são
    // do setor ADMINISTRATIVO — eles entram só pra receber mensagens, mas
    // como representam a gestão, fazem sentido ter poder de admin no grupo.
    // Falha aqui é não-fatal: o grupo já existe, só não terão a permissão.
    if (jid && employeeIds.length > 0) {
      try {
        const adminEmps = await prisma.employee.findMany({
          where: { id: { in: employeeIds }, sector: "ADMINISTRATIVO" },
          select: { phone: true },
        });
        const adminPhones = adminEmps
          .map((e) => (e.phone || "").trim())
          .filter((p) => p.length > 0);
        if (adminPhones.length > 0) {
          await updateGroupParticipants(jid, "promote", adminPhones);
        }
      } catch (promoteErr) {
        console.warn("[groups] promote admins failed:", (promoteErr as Error).message);
      }
    }

    if (shipId && jid) {
      try {
        await prisma.ship.update({
          where: { id: shipId },
          data: { whatsapp_group_jid: jid },
        });
      } catch (err) {
        // Group was created on WhatsApp but we couldn't link — surface, don't fail.
        return NextResponse.json({
          status: "partial",
          jid,
          warning: `Grupo criado, mas falhou ao vincular ao navio: ${(err as Error).message}`,
        });
      }

      // Envio de mensagem inicial pro grupo com info da operação. Falha aqui
      // não derruba a criação do grupo — só logamos.
      try {
        const ship = await prisma.ship.findUnique({
          where: { id: shipId },
          select: {
            name: true,
            arrival_date: true,
            departure_date: true,
            port: true,
            cargo_type: true,
            holds_count: true,
            services: true,
            assigned_team: true,
            boarding_situation: true,
            boarding_scheduled_at: true,
          },
        });
        if (ship) {
          const { description, message } = buildShipWelcomeMessage(ship);
          // Descrição do grupo recebe só as infos da operação (sem o
          // "Aguardem instruções..."), pra ficar limpo no painel do grupo.
          // Falha aqui é não-fatal.
          try {
            await setWhatsappGroupDescription(jid, description);
          } catch (descErr) {
            console.warn("[groups] set description failed:", (descErr as Error).message);
          }
          await sendWhatsappTextToGroup(jid, message);
          // Persiste a mensagem rica de boas-vindas no histórico do app —
          // sem isso a aba Conversas só mostra o stub "Grupo criado" e o
          // usuário não vê no app o que foi enviado pro WhatsApp.
          try {
            await prisma.whatsappMessage.create({
              data: {
                message_id: `welcome-${jid}-${Date.now()}`,
                instance_name: process.env.EVOLUTION_INSTANCE || "default",
                remote_jid: jid,
                from_me: true,
                push_name: subject,
                message_type: "conversation",
                text: message,
                timestamp_ms: BigInt(Date.now()),
                sent_by_user_id: session.user.id || null,
                raw_event: { source: "groups-welcome", subject },
              },
            });
          } catch (welcomeStubErr) {
            console.warn("[groups] welcome stub insert failed:", (welcomeStubErr as Error).message);
          }
        }
      } catch (err) {
        console.warn("[groups] welcome message failed:", (err as Error).message);
      }
    }

    return NextResponse.json({ status: "ok", jid, raw: created });
  } catch (err) {
    return NextResponse.json({ error: friendlyEvolutionError((err as Error).message) }, { status: 502 });
  }
}
