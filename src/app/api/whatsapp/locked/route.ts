import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Conversas travadas pra envio manual (o "cadeado" na aba Conversas).
//   GET  → { jids }                  lista os remote_jid travados
//   POST { jid, locked }             trava (true) ou destrava (false)

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await prisma.lockedConversation.findMany({ select: { remote_jid: true } });
  return NextResponse.json({ jids: rows.map((r) => r.remote_jid) });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { jid?: string; locked?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const jid = (body.jid || "").trim();
  if (!jid) return NextResponse.json({ error: "jid obrigatório" }, { status: 400 });

  if (body.locked) {
    await prisma.lockedConversation.upsert({
      where: { remote_jid: jid },
      update: { locked_by: session.user.id || null },
      create: { remote_jid: jid, locked_by: session.user.id || null },
    });
  } else {
    await prisma.lockedConversation.deleteMany({ where: { remote_jid: jid } });
  }
  return NextResponse.json({ jid, locked: !!body.locked });
}
