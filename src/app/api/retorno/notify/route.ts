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

type IncidentKind = "perdido" | "insumo" | "avariado";
interface BrokenItem {
  name: string;
  qty: number;
  unit?: string | null;
  note?: string | null;
  // A tela manda a categoria de cada ocorrência. Legado (sem kind) é inferido
  // da observação, que antigamente carregava a etiqueta ("PERDIDO — ...").
  kind?: IncidentKind;
}
interface NotifyBody {
  shipName: string;
  team?: string | null;
  brokenItems: BrokenItem[];
  notes?: string | null;
  checkedBy?: string | null;
  // "quebrados" (padrão) = botão "Enviar quebrados"; "resumo" = aviso automático
  // do ✅ Confirmar Retorno (inclui também o que voltou bom).
  event?: "quebrados" | "resumo";
  returnedItems?: BrokenItem[];
}

const TEAM_LABEL: Record<string, string> = {
  EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3", EQUIPE_4: "Equipe Turbo",
};

// "— 2 un" / "— 5 kg"; sem unidade cadastrada sai só o número.
function qtyLabel(it: BrokenItem): string {
  const u = unitShort(it.unit);
  return it.qty > 0 ? `${it.qty}${u ? ` ${u}` : ""}` : "";
}

// Categoria de uma ocorrência do legado (sem `kind`): a etiqueta vinha no
// começo da observação ("PERDIDO — ...", "avariado — ...").
function inferKind(note?: string | null): IncidentKind | null {
  const n = (note || "").trim().toLowerCase();
  if (n.startsWith("perdido")) return "perdido";
  if (n.startsWith("insumo")) return "insumo";
  if (n.startsWith("avariado")) return "avariado";
  return null;
}

// Tira a etiqueta do começo da observação legada, deixando só o texto livre.
function cleanNote(note?: string | null): string | null {
  if (!note) return null;
  const stripped = note.replace(/^\s*(perdido|insumo|avariado)\s*(—|-|:)?\s*/i, "").trim();
  return stripped || null;
}

// "• *ITEM* — 2 un — obs" (a categoria já é o título da seção).
function fmtLine(it: BrokenItem): string {
  const qty = qtyLabel(it);
  const note = it.note?.trim() ? ` — ${it.note.trim()}` : "";
  return `• *${it.name}*${qty ? ` — ${qty}` : ""}${note}`;
}

// Ocorrências agrupadas em seções: ❌ Perdido, 🛢️ Insumo, 🔧 Avariado (nessa
// ordem — perdido é o que custa ao navio). Cada linha fica curta; a etiqueta
// que antes ia em toda linha virou o título da seção.
function incidentSections(items: BrokenItem[]): string {
  const groups: Record<IncidentKind, BrokenItem[]> = { perdido: [], insumo: [], avariado: [] };
  const outros: BrokenItem[] = [];
  for (const it of items) {
    const kind = it.kind || inferKind(it.note);
    // Sem kind é legado: a observação carregava a etiqueta — limpa pra não repetir.
    const line = it.kind ? it : { ...it, note: cleanNote(it.note) };
    if (kind === "perdido") groups.perdido.push(line);
    else if (kind === "insumo") groups.insumo.push(line);
    else if (kind === "avariado") groups.avariado.push(line);
    else outros.push(it);
  }
  const blocks: string[] = [];
  if (groups.perdido.length) blocks.push(`❌ *Perdido (${groups.perdido.length})*\n${groups.perdido.map(fmtLine).join("\n")}`);
  if (groups.insumo.length) blocks.push(`🛢️ *Insumo (${groups.insumo.length})*\n${groups.insumo.map(fmtLine).join("\n")}`);
  if (groups.avariado.length) blocks.push(`🔧 *Avariado (${groups.avariado.length})*\n${groups.avariado.map(fmtLine).join("\n")}`);
  if (outros.length) blocks.push(`⚠️ *Ocorrências (${outros.length})*\n${outros.map(fmtLine).join("\n")}`);
  return blocks.join("\n\n");
}

// Mensagem do retorno. "quebrados": só as ocorrências, pra manutenção/compras
// reporem. "resumo": retorno confirmado — quantos voltaram bem (só a contagem,
// pra não estourar o texto) + as ocorrências. Vai por DM pro Administrativo
// e/ou pro grupo.
//
// As ocorrências saem SEPARADAS em ❌ Perdido / 🛢️ Insumo / 🔧 Avariado:
// perdido não voltou (vira custo do navio), insumo foi consumido de propósito,
// avariado voltou quebrado (a equipe trouxe).
function buildMessage(b: NotifyBody): string {
  const team = b.team ? ` · ${TEAM_LABEL[b.team] || b.team}` : "";
  const extra = b.notes?.trim() ? `\n📝 ${b.notes.trim()}\n` : "";
  const by = b.checkedBy?.trim() ? `\n👤 Conferido por: ${b.checkedBy.trim()}` : "";
  const sections = incidentSections(b.brokenItems);

  if (b.event === "resumo") {
    const n = (b.returnedItems || []).length;
    const returnedLine = n ? `✔️ Voltou em bom estado: ${n} ${n === 1 ? "item" : "itens"}\n\n` : "";
    return (
      `✅ *Retorno confirmado*\n\n` +
      `🚢 Navio: *${b.shipName}*${team}\n\n` +
      returnedLine +
      (sections ? sections + "\n" : "✅ Nada perdido, consumido ou avariado.\n") +
      extra + by
    );
  }

  return (
    `🛠️ *Retorno de material*\n\n` +
    `🚢 Navio: *${b.shipName}*${team}\n\n` +
    (sections || "Nada perdido, consumido ou avariado.") +
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
  // No resumo (auto do Confirmar Retorno) zero quebrado é notícia boa — envia
  // mesmo assim. Só o fluxo manual de quebrados exige ao menos um item.
  if (body.brokenItems.length === 0 && body.event !== "resumo") {
    return NextResponse.json({ status: "skipped", sent: 0, warning: "Nenhum item quebrado pra enviar." }, { status: 200 });
  }

  // Card "Retorno de material" em Mensagens: liga/desliga o aviso, o GRUPO é o
  // destino principal e a caixinha "dmAdmin" opcionalmente manda também por DM
  // pro pessoal do setor ADMINISTRATIVO.
  const { retornoMaterial: cfg } = await readNotifyConfig();
  if (!cfg.enabled) {
    return NextResponse.json({
      status: "skipped",
      sent: 0,
      skipped: "Aviso de retorno desativado — ligue em Mensagens › Avisos, card \"Retorno de material\".",
    }, { status: 200 });
  }
  const targetGroups = cfg.groups;
  if (targetGroups.length === 0 && !cfg.dmAdmin) {
    return NextResponse.json({
      status: "skipped",
      sent: 0,
      warning: "Nenhum grupo configurado — escolha um em Mensagens › Avisos, card \"Retorno de material\".",
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

  // DM pro pessoal ATIVO do setor ADMINISTRATIVO só com a caixinha ligada no
  // card. Não-fatal por pessoa (sem telefone entra como falha no resumo).
  const admins = cfg.dmAdmin
    ? (
        await prisma.employee.findMany({
          where: { sector: "ADMINISTRATIVO" },
          select: { id: true, name: true, phone: true, status: true },
        })
      ).filter((e) => e.status !== "INATIVO")
    : [];

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
