import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isEvolutionConfigured, leaveWhatsappGroup } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";
import { clearTeamGroupCache } from "@/lib/services/team-groups";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// POST /api/whatsapp/groups/[jid]/leave
//
// Faz o número conectado (o "bot" do sistema) sair do grupo no WhatsApp, via
// Evolution. É o complemento de "Novo grupo": dá pra criar e agora também sair
// pelo sistema, sem precisar abrir o WhatsApp.
//
// Efeitos colaterais (todos não-fatais — já saímos do grupo de fato):
//   • Desvincula qualquer navio que apontava pra esse grupo
//     (whatsapp_group_jid = null) — sem o bot no grupo, a escala automática
//     não teria mais pra onde ir.
//   • Registra um aviso "🚪 Saiu do grupo" na conversa (systemNotice), estilo
//     WhatsApp, pra deixar rastro de quem saiu e quando.
//   • Limpa o cache dos grupos de equipe, caso esse fosse o JID da Equipe 1/2.
//
// NÃO apaga o histórico local — sair ≠ apagar a conversa. Pra remover as
// mensagens do sistema, use o botão de apagar conversa.
export async function POST(
  _req: Request,
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

  try {
    await leaveWhatsappGroup(jid);
  } catch (err) {
    return NextResponse.json(
      { error: friendlyEvolutionError((err as Error).message) },
      { status: 502 },
    );
  }

  // Desvincula navios que usavam esse grupo. Falha aqui é não-fatal (já saímos),
  // mas reportamos pra UI avisar.
  let unlinkedShips = 0;
  let warning: string | null = null;
  try {
    const result = await prisma.ship.updateMany({
      where: { whatsapp_group_jid: jid },
      data: { whatsapp_group_jid: null },
    });
    unlinkedShips = result.count;
  } catch (err) {
    warning = `Saí do grupo, mas falhei ao desvincular o navio: ${(err as Error).message}`;
    console.warn("[groups] leave: unlink ship failed:", (err as Error).message);
  }

  // Marca o evento na conversa (estilo WhatsApp).
  try {
    await prisma.whatsappMessage.create({
      data: {
        message_id: `system-leave-${jid}-${Date.now()}`,
        instance_name: process.env.EVOLUTION_INSTANCE || "default",
        remote_jid: jid,
        from_me: true,
        push_name: session.user.name || null,
        message_type: "systemNotice",
        text: "🚪 O sistema saiu do grupo",
        timestamp_ms: BigInt(Date.now()),
        sent_by_user_id: session.user.id || null,
        raw_event: { source: "groups-leave" },
      },
    });
  } catch (stubErr) {
    console.warn("[groups] leave stub insert failed:", (stubErr as Error).message);
  }

  // Caso esse fosse o grupo da Equipe 1/2, o próximo lookup precisa reavaliar.
  clearTeamGroupCache();

  return NextResponse.json({
    status: warning ? "partial" : "ok",
    left: true,
    unlinkedShips,
    ...(warning && { warning }),
  });
}
