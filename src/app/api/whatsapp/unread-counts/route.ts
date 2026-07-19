import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "COMERCIAL", "FINANCEIRO"];

// POST /api/whatsapp/unread-counts
// Body: { seen: { [remote_jid]: number } }  — timestamp_ms do último visto por
// conversa (vem do localStorage do cliente).
// Retorna { counts: { [remote_jid]: number } } com a quantidade de mensagens
// RECEBIDAS (from_me=false) e reais (não systemNotice / groupParticipantUpdate)
// com timestamp_ms maior que o "visto". Só inclui conversas com count > 0.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { seen?: Record<string, number | string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const seen = body.seen || {};
  // Cap defensivo: conta no máximo 100 conversas por chamada.
  const jids = Object.keys(seen).slice(0, 100);

  try {
    const counts: Record<string, number> = {};
    await Promise.all(
      jids.map(async (jid) => {
        const since = BigInt(Math.trunc(Number(seen[jid]) || 0));
        const n = await prisma.whatsappMessage.count({
          where: {
            remote_jid: jid,
            from_me: false,
            timestamp_ms: { gt: since },
            message_type: { notIn: ["systemNotice", "groupParticipantUpdate"] },
          },
        });
        if (n > 0) counts[jid] = n;
      }),
    );
    return NextResponse.json({ counts });
  } catch (err) {
    console.error("unread-counts error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
