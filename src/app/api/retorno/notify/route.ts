import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  sendWhatsappText,
  extractSentMessageId,
} from "@/lib/services/evolution-api";
import { readNotifyConfig } from "@/lib/services/solicitacoes-notify-config";
import { unitShort } from "@/lib/stock-units";

interface BrokenItem { name: string; qty: number; unit?: string | null; note?: string | null }
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
// compras reporem. Vai por DM pro Administrativo e, se escolhido, pro grupo.
function buildMessage(b: NotifyBody): string {
  const team = b.team ? ` · ${TEAM_LABEL[b.team] || b.team}` : "";
  const lines = b.brokenItems.map((it) => {
    // "— 2 un" / "— 5 kg"; sem unidade cadastrada sai só o número.
    const u = unitShort(it.unit);
    const qty = it.qty > 0 ? ` — ${it.qty}${u ? ` ${u}` : ""}` : "";
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

// POST /api/retorno/notify — manda a lista de quebrados por DM pro pessoal do
// setor ADMINISTRATIVO e, se configurado em Mensagens, também pro grupo
// escolhido. Best-effort: sempre 200, nunca fatal.
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

  // Card "Retorno de material" em Mensagens: liga/desliga o aviso e escolhe um
  // grupo OPCIONAL (útil pra testes). Quando ligado, o aviso vai sempre por DM
  // pro pessoal do setor ADMINISTRATIVO — sem grupo escolhido, vai só as DMs.
  const { retornoMaterial: cfg } = await readNotifyConfig();
  if (!cfg.enabled) {
    return NextResponse.json({
      status: "skipped",
      sent: 0,
      skipped: "Aviso de retorno desativado — ligue em Mensagens › Avisos, card \"Retorno de material\".",
    }, { status: 200 });
  }
  const targetGroups = cfg.groups;

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

  // DM sempre pro pessoal ATIVO do setor ADMINISTRATIVO — é quem cuida da
  // reposição. Não-fatal por pessoa (sem telefone entra como falha no resumo).
  const admins = (
    await prisma.employee.findMany({
      where: { sector: "ADMINISTRATIVO" },
      select: { id: true, name: true, phone: true, status: true },
    })
  ).filter((e) => e.status !== "INATIVO");

  const dmResults: { target: string; ok: boolean; error?: string }[] = [];
  for (const emp of admins) {
    if (!emp.phone || emp.phone.trim().length < 10) {
      dmResults.push({ target: `dm:${emp.name}`, ok: false, error: "sem telefone válido" });
      continue;
    }
    try {
      await sendWhatsappText(emp.phone, message);
      dmResults.push({ target: `dm:${emp.name}`, ok: true });
    } catch (err) {
      dmResults.push({ target: `dm:${emp.name}`, ok: false, error: (err as Error).message });
    }
  }

  const dmSent = dmResults.filter((r) => r.ok).length;
  const sent = groupResults.filter((r) => r.ok).length;
  if (sent === 0 && dmSent === 0) {
    return NextResponse.json({
      status: "error",
      sent: 0,
      dmSent: 0,
      warning: "Ninguém recebeu o aviso — escolha um grupo em Mensagens › \"Retorno de material\" ou confira os telefones do pessoal do Administrativo.",
      results: groupResults,
      dmResults,
    }, { status: 200 });
  }
  return NextResponse.json({
    status: "ok",
    sent,
    group: groupResults.filter((r) => r.ok).map((r) => r.name).join(", "),
    results: groupResults,
    dmSent,
    dmResults,
  }, { status: 200 });
}
