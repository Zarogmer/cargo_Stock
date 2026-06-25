import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// GET /api/whatsapp/media/[messageId]
// Fetches the media base64 from Evolution on-demand. We don't store binary in
// the DB to keep it slim — Evolution holds the original payload and reuses it.
// Returns { base64, mimetype } or the raw bytes when ?raw=1 is set.
export async function GET(req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { messageId: encodedId } = await params;
  const messageId = decodeURIComponent(encodedId);

  // Look up the message so we know which instance/remote_jid it belongs to
  const msg = await prisma.whatsappMessage.findFirst({
    where: { message_id: messageId },
    select: { instance_name: true, remote_jid: true, from_me: true, media_mimetype: true, message_id: true },
  });
  if (!msg) return NextResponse.json({ error: "Mensagem não encontrada" }, { status: 404 });

  const url = (process.env.EVOLUTION_API_URL || "").replace(/\/$/, "");
  const apikey = process.env.EVOLUTION_API_KEY;
  if (!url || !apikey) return NextResponse.json({ error: "Evolution não configurado" }, { status: 503 });

  try {
    // Evolution exposes /chat/getBase64FromMediaMessage/{instance}
    const res = await fetch(`${url}/chat/getBase64FromMediaMessage/${encodeURIComponent(msg.instance_name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey },
      body: JSON.stringify({
        message: {
          key: { id: messageId, remoteJid: msg.remote_jid, fromMe: msg.from_me },
        },
        convertToMp4: false,
      }),
    });
    const body = (await res.json().catch(() => null)) as { base64?: string; mimetype?: string; message?: string } | null;
    if (!res.ok || !body?.base64) {
      return NextResponse.json({ error: body?.message || `Evolution ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({
      base64: body.base64,
      mimetype: body.mimetype || msg.media_mimetype || "application/octet-stream",
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
