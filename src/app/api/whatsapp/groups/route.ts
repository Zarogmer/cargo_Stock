import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createWhatsappGroup, isEvolutionConfigured } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

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
    }

    return NextResponse.json({ status: "ok", jid, raw: created });
  } catch (err) {
    return NextResponse.json({ error: friendlyEvolutionError((err as Error).message) }, { status: 502 });
  }
}
