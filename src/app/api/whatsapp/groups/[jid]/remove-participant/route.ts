import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isEvolutionConfigured, updateGroupParticipants } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// POST /api/whatsapp/groups/[jid]/remove-participant
//
// Remove OUTRO participante do grupo no WhatsApp, via Evolution. É o complemento
// de "Sair do grupo" (/leave, que faz o próprio número conectado sair): aqui
// tiramos um terceiro. Body: { phone, name? } — telefone do participante a
// remover (dígitos, com ou sem 55).
//
// NÃO grava uma pílula "➖ saiu do grupo" otimista: o próprio WhatsApp dispara
// o evento group.participants.update pra remoções feitas pela API, e o webhook
// (handleGroupParticipantsUpdate) já registra a pílula vermelha na conversa —
// criar uma aqui duplicaria. A lista de participantes do painel é recarregada
// na hora, então o usuário tem feedback imediato de que a pessoa saiu.
//
// Pré-condição no WhatsApp: o número conectado precisa ser admin do grupo, e
// não dá pra remover o dono (superadmin). Se o WhatsApp recusar, devolvemos o
// erro amigável.
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

  let body: { phone?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const phone = (body.phone || "").replace(/\D/g, "");
  if (phone.length < 10) {
    return NextResponse.json({ error: "Telefone do participante inválido" }, { status: 400 });
  }

  try {
    const result = await updateGroupParticipants(jid, "remove", [phone]);
    // updateGroupParticipants devolve { skipped } sem chamar a Evolution quando
    // o número não passa na validação (ex.: dígitos demais/de menos). Tratamos
    // como erro pra não dar "sucesso" silencioso sem remover ninguém.
    if (result && typeof result === "object" && "skipped" in result) {
      return NextResponse.json(
        { error: "Não foi possível remover: telefone do participante inválido." },
        { status: 400 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: friendlyEvolutionError((err as Error).message) },
      { status: 502 },
    );
  }

  return NextResponse.json({ status: "ok", removed: true });
}
