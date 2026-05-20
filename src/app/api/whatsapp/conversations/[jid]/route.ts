import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// DELETE /api/whatsapp/conversations/[jid]
// Removes the conversation from our DB only (Evolution/WhatsApp side is left
// untouched — the contact still has the messages on their phone). Wipes every
// row in whatsapp_messages with this remote_jid.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ jid: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { jid: encodedJid } = await params;
  const jid = decodeURIComponent(encodedJid);

  try {
    const result = await prisma.whatsappMessage.deleteMany({
      where: { remote_jid: jid },
    });
    return NextResponse.json({ status: "ok", deleted: result.count });
  } catch (err) {
    console.error("conversation DELETE error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
