import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isEvolutionConfigured, updateGroupParticipants } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// POST /api/whatsapp/groups/[jid]/promote-participant
//
// Promove (→ admin) ou rebaixa (→ membro) um participante do grupo, via
// Evolution. Body: { phone, action: "promote" | "demote" } — telefone em
// dígitos (com ou sem 55).
//
// IMPORTANTE: o WhatsApp/Evolution NÃO expõe transferência do "Dono"
// (superadmin/criador) — o máximo que dá pra conceder é "admin". Por isso só
// promovemos/rebaixamos admin; o Dono continua sendo quem criou o grupo.
//
// Pré-condição no WhatsApp: o número conectado (o "bot" do sistema) precisa ser
// admin/dono do grupo. Se o WhatsApp recusar, devolvemos o erro amigável.
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

  let body: { phone?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const phone = (body.phone || "").replace(/\D/g, "");
  if (phone.length < 10) {
    return NextResponse.json({ error: "Telefone do participante inválido" }, { status: 400 });
  }
  const action: "promote" | "demote" = body.action === "demote" ? "demote" : "promote";

  try {
    const result = await updateGroupParticipants(jid, action, [phone]);
    // updateGroupParticipants devolve { skipped } sem chamar a Evolution quando
    // o número não passa na validação — tratamos como erro pra não dar "sucesso"
    // silencioso sem promover ninguém.
    if (result && typeof result === "object" && "skipped" in result) {
      return NextResponse.json(
        { error: "Não foi possível alterar: telefone do participante inválido." },
        { status: 400 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: friendlyEvolutionError((err as Error).message) },
      { status: 502 },
    );
  }

  return NextResponse.json({ status: "ok", action });
}
