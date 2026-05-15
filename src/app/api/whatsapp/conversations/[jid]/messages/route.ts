import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

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
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || "100"), 500);
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

    // Serialize BigInt for JSON
    const messages = rows.reverse().map((m) => ({
      ...m,
      timestamp_ms: m.timestamp_ms.toString(),
    }));

    return NextResponse.json({ messages });
  } catch (err) {
    console.error("messages GET error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
