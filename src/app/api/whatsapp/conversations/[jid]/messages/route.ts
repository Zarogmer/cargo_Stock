import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { extractMentionNumbers, resolveMentionNames } from "@/lib/services/whatsapp-mentions";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// Reações chegam como mensagens do tipo "reactionMessage". O emoji e o id da
// mensagem reagida ficam no payload bruto (raw_event) — extraímos na leitura
// pra exibir a reação na bolha alvo, sem precisar mudar o schema do banco.
function extractReaction(raw: unknown): { targetId: string | null; emoji: string | null } {
  if (!raw || typeof raw !== "object") return { targetId: null, emoji: null };
  const data = (raw as Record<string, unknown>).data;
  const message = data && typeof data === "object" ? (data as Record<string, unknown>).message : undefined;
  const rm = message && typeof message === "object" ? (message as Record<string, unknown>).reactionMessage : undefined;
  if (!rm || typeof rm !== "object") return { targetId: null, emoji: null };
  const rmObj = rm as Record<string, unknown>;
  const key = rmObj.key && typeof rmObj.key === "object" ? (rmObj.key as Record<string, unknown>) : undefined;
  const targetId = key && typeof key.id === "string" ? key.id : null;
  const emoji = typeof rmObj.text === "string" && rmObj.text.trim() ? rmObj.text : null;
  return { targetId, emoji };
}

// GET /api/whatsapp/conversations/[jid]/messages?limit=100&before=<timestamp_ms>
// Returns messages in a conversation, newest-first. `before` is for pagination
// (load older messages by passing the oldest currently-shown timestamp).
export async function GET(req: NextRequest, { params }: { params: Promise<{ jid: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { jid: encodedJid } = await params;
  const jid = decodeURIComponent(encodedJid);
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || "100"), 5000);
  const beforeParam = req.nextUrl.searchParams.get("before");
  const before = beforeParam ? BigInt(beforeParam) : null;

  try {
    const rows = await prisma.whatsappMessage.findMany({
      where: {
        remote_jid: jid,
        ...(before ? { timestamp_ms: { lt: before } } : {}),
      },
      orderBy: { timestamp_ms: "desc" },
      take: limit,
      select: {
        id: true,
        message_id: true,
        remote_jid: true,
        from_me: true,
        push_name: true,
        message_type: true,
        text: true,
        media_mimetype: true,
        media_filename: true,
        timestamp_ms: true,
        created_at: true,
      },
    });

    // O raw_event (payload bruto) é o campo mais pesado da tabela, então não o
    // trazemos na query principal. Reações guardam o emoji + id da mensagem
    // alvo lá dentro — buscamos esse campo só pras reações da janela (poucas).
    const reactionIds = rows.filter((r) => r.message_type === "reactionMessage").map((r) => r.id);
    const rawById = new Map<string, unknown>();
    if (reactionIds.length > 0) {
      const raws = await prisma.whatsappMessage.findMany({
        where: { id: { in: reactionIds } },
        select: { id: true, raw_event: true },
      });
      for (const r of raws) rawById.set(r.id, r.raw_event);
    }

    // Serialize BigInt for JSON + anexa emoji/alvo nas reações.
    const messages = rows.reverse().map((m) => {
      const reaction = m.message_type === "reactionMessage"
        ? extractReaction(rawById.get(m.id))
        : { targetId: null, emoji: null };
      return {
        ...m,
        timestamp_ms: m.timestamp_ms.toString(),
        reacted_to_id: reaction.targetId,
        reaction_emoji: reaction.emoji,
      };
    });

    // Resolve as menções "@<número>" do texto para nomes. Em grupos, os números
    // são LIDs de privacidade — cruzamos com o histórico do grupo e o cadastro
    // pra mostrar quem foi mencionado/convocado em vez do número cru.
    const mentionNums = new Set<string>();
    for (const m of messages) {
      for (const n of extractMentionNumbers(m.text)) mentionNums.add(n);
    }
    const mentions = mentionNums.size > 0
      ? await resolveMentionNames([...mentionNums], jid)
      : {};

    return NextResponse.json({ messages, mentions });
  } catch (err) {
    console.error("messages GET error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
