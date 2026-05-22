import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createWhatsappGroup, isEvolutionConfigured } from "@/lib/services/evolution-api";

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
    return NextResponse.json({ error: friendlyError((err as Error).message) }, { status: 502 });
  }
}

// Translate Evolution/Baileys errors into something a non-engineer can act on.
function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("connection closed") || lower.includes("connection lost")) {
    return "WhatsApp desconectado no servidor. Abra a aba WhatsApp API, confira o status e escaneie o QR Code novamente.";
  }
  if (lower.includes("not exists") || lower.includes("does not exist")) {
    return "Um dos números informados não tem WhatsApp ou está inválido. Confirme os contatos selecionados.";
  }
  if (lower.includes("timeout")) {
    return "Tempo esgotado falando com o WhatsApp. Tenta de novo em alguns segundos.";
  }
  return raw;
}
