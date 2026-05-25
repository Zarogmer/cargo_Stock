import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createWhatsappGroup,
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  setWhatsappGroupDescription,
} from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

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

function formatDateBr(d: Date | null | undefined): string | null {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const day = String(dt.getUTCDate()).padStart(2, "0");
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${dt.getUTCFullYear()}`;
}

// Monta a mensagem inicial que vai pro grupo logo após criar o grupo,
// avisando os funcionários sobre a operação (data, produto, serviços, porto, etc.).
// Retorna duas variantes: `description` (só info, vira descrição do grupo) e
// `message` (info + assinatura "Aguardem...", vai como mensagem no chat).
function buildShipWelcomeMessage(ship: {
  name: string;
  arrival_date: Date | null;
  departure_date: Date | null;
  port: string | null;
  cargo_type: string | null;
  holds_count: number | null;
  services: string[];
  assigned_team: string | null;
  client_name: string | null;
}): { description: string; message: string } {
  const isCostado = ship.services.includes("COSTADO");
  const opType = isCostado ? "COSTADO" : "EMBARQUE";
  const opEmoji = isCostado ? "🛟" : "⚓";

  const lines: string[] = [];
  lines.push(`📢 *NOVA OPERAÇÃO — ${opType}* ${opEmoji}`);
  lines.push("");
  lines.push(`🚢 *Navio:* ${ship.name}`);

  const arr = formatDateBr(ship.arrival_date);
  const dep = formatDateBr(ship.departure_date);
  if (arr && dep) lines.push(`📅 *Data:* ${arr} → ${dep}`);
  else if (arr) lines.push(`📅 *Chegada:* ${arr}`);
  else if (dep) lines.push(`📅 *Saída:* ${dep}`);

  if (ship.port) lines.push(`📍 *Local:* ${ship.port}`);
  if (ship.cargo_type) lines.push(`📦 *Produto:* ${ship.cargo_type}`);
  if (ship.holds_count != null) lines.push(`🕳️ *Porões:* ${ship.holds_count}`);

  if (!isCostado) {
    const subs = ship.services.filter((s) => s !== "COSTADO");
    if (subs.length > 0) {
      const labels = subs.map((s) => SERVICE_LABELS[s] || s).join(", ");
      lines.push(`🔧 *Serviços:* ${labels}`);
    }
  } else {
    lines.push(`🔧 *Serviço:* Costado (escalação por hora)`);
  }

  if (ship.client_name) lines.push(`🏢 *Cliente:* ${ship.client_name}`);
  if (ship.assigned_team) {
    lines.push(`👥 *Equipe:* ${TEAM_LABELS[ship.assigned_team] || ship.assigned_team}`);
  }

  const description = lines.join("\n");
  const message = `${description}\n\n_Aguardem instruções da supervisão. Bom trabalho! 🚀_`;
  return { description, message };
}

// POST /api/whatsapp/groups
// Body: { subject: string, participants: string[], shipId?: string }
// Creates a WhatsApp group via Evolution and (optionally) links it to a ship by
// storing the returned JID in Ship.whatsapp_group_jid — that's what the
// auto-schedule message targets later.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }

  let body: { subject?: string; participants?: string[]; shipId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const subject = body.subject?.trim();
  const participants = Array.isArray(body.participants) ? body.participants : [];
  const shipId = body.shipId?.trim() || null;

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
            raw_event: { source: "groups-create", subject, participants_count: participants.length },
          },
        });
      } catch (stubErr) {
        // Non-fatal: the group exists on WhatsApp regardless. The user can use
        // "Sincronizar grupos" to backfill later.
        console.warn("[groups] stub insert failed:", (stubErr as Error).message);
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
            client_name: true,
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
