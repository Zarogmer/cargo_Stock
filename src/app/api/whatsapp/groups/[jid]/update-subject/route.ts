import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isEvolutionConfigured, updateWhatsappGroupSubject } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// POST /api/whatsapp/groups/[jid]/update-subject  — body: { subject }
//
// Renomeia o grupo no WhatsApp (via Evolution) e atualiza o stub local
// "systemNotice" (que guarda o nome exibido na lista de Conversas) pra a UI
// refletir o novo nome na hora, sem esperar uma nova sincronização.
//
// Pré-condição no WhatsApp: o número conectado precisa ser admin/dono do grupo.
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ jid: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }

  const { jid: rawJid } = await context.params;
  const jid = decodeURIComponent(rawJid);
  if (!jid.endsWith("@g.us")) {
    return NextResponse.json({ error: "JID não é de grupo" }, { status: 400 });
  }

  let body: { subject?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const subject = (body.subject || "").trim();
  if (!subject) return NextResponse.json({ error: "Nome do grupo é obrigatório" }, { status: 400 });
  if (subject.length > 100) return NextResponse.json({ error: "Nome muito longo (máx. 100 caracteres)" }, { status: 400 });

  try {
    await updateWhatsappGroupSubject(jid, subject);
  } catch (err) {
    return NextResponse.json(
      { error: friendlyEvolutionError((err as Error).message) },
      { status: 502 },
    );
  }

  // Mantém o stub de exibição em sincronia com o novo nome (best-effort).
  try {
    await prisma.whatsappMessage.updateMany({
      where: { remote_jid: jid, from_me: true, message_type: "systemNotice" },
      data: { push_name: subject },
    });
  } catch (err) {
    console.warn("[update-subject] stub update failed:", (err as Error).message);
  }

  return NextResponse.json({ status: "ok", subject });
}
