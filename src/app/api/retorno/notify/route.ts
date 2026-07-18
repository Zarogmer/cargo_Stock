import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  extractSentMessageId,
} from "@/lib/services/evolution-api";
import { getComprasGroupJid, comprasGroupName } from "@/lib/services/compras-group";
import { readNotifyConfig } from "@/lib/services/solicitacoes-notify-config";

interface BrokenItem { name: string; qty: number; note?: string | null }
interface NotifyBody {
  shipName: string;
  team?: string | null;
  brokenItems: BrokenItem[];
  notes?: string | null;
  checkedBy?: string | null;
}

const TEAM_LABEL: Record<string, string> = {
  EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3",
};

// Mensagem do retorno: lista o material que voltou QUEBRADO, pra manutenção /
// compras reporem. Mesmo grupo dos avisos de solicitação/compra.
function buildMessage(b: NotifyBody): string {
  const team = b.team ? ` · ${TEAM_LABEL[b.team] || b.team}` : "";
  const lines = b.brokenItems.map((it) => {
    const qty = it.qty > 0 ? ` (x${it.qty})` : "";
    const note = it.note?.trim() ? ` — ${it.note.trim()}` : "";
    return `• *${it.name}*${qty}${note}`;
  });
  const extra = b.notes?.trim() ? `\n📝 ${b.notes.trim()}\n` : "";
  const by = b.checkedBy?.trim() ? `\n👤 Conferido por: ${b.checkedBy.trim()}` : "";
  return (
    `🛠️ *Retorno de material — quebrados*\n\n` +
    `🚢 Navio: *${b.shipName}*${team}\n\n` +
    (lines.length ? lines.join("\n") : "Nenhum item quebrado.") +
    "\n" + extra + by
  );
}

// POST /api/retorno/notify — manda a lista de quebrados pro grupo de Compras
// (o mesmo dos avisos de solicitação). Best-effort: sempre 200, nunca fatal.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isEvolutionConfigured()) {
    return NextResponse.json({ skipped: "Evolution API não configurada", sent: 0 }, { status: 200 });
  }

  let body: NotifyBody;
  try {
    body = (await request.json()) as NotifyBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (!body.shipName || !Array.isArray(body.brokenItems)) {
    return NextResponse.json({ error: "shipName e brokenItems são obrigatórios" }, { status: 400 });
  }
  if (body.brokenItems.length === 0) {
    return NextResponse.json({ status: "skipped", sent: 0, warning: "Nenhum item quebrado pra enviar." }, { status: 200 });
  }

  // Mesmo alvo do aviso de compras: grupos configurados ou o resolvedor por nome.
  const { compraConcluida: cfg } = await readNotifyConfig();
  let targetGroups = cfg.groups;
  if (targetGroups.length === 0) {
    const fallbackJid = await getComprasGroupJid();
    if (fallbackJid) targetGroups = [{ jid: fallbackJid, label: comprasGroupName() }];
  }
  if (targetGroups.length === 0) {
    const name = comprasGroupName();
    return NextResponse.json({
      status: "skipped",
      sent: 0,
      warning: `Nenhum grupo configurado. Escolha um em Mensagens › Avisos de Solicitações e Compras, ou crie o grupo "${name}" no WhatsApp e rode "Sincronizar grupos".`,
    }, { status: 200 });
  }

  const message = buildMessage(body);
  const groupResults: { name: string; ok: boolean; error?: string }[] = [];
  for (const g of targetGroups) {
    const groupName = g.label || g.jid;
    try {
      const sentResult = await sendWhatsappTextToGroup(g.jid, message);
      groupResults.push({ name: groupName, ok: true });
      try {
        await prisma.whatsappMessage.create({
          data: {
            message_id: extractSentMessageId(sentResult) ?? `retorno-${g.jid}-${Date.now()}`,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: g.jid,
            from_me: true,
            push_name: groupName,
            message_type: "conversation",
            text: message,
            timestamp_ms: BigInt(Date.now()),
            sent_by_user_id: session.user.id || null,
            raw_event: { source: "retorno-material", shipName: body.shipName },
          },
        });
      } catch (stubErr) {
        console.warn("[retorno/notify] stub insert failed:", (stubErr as Error).message);
      }
    } catch (err) {
      groupResults.push({ name: groupName, ok: false, error: (err as Error).message });
    }
  }

  const sent = groupResults.filter((r) => r.ok).length;
  return NextResponse.json({
    status: sent > 0 ? "ok" : "error",
    sent,
    group: groupResults.filter((r) => r.ok).map((r) => r.name).join(", "),
    results: groupResults,
  }, { status: 200 });
}
