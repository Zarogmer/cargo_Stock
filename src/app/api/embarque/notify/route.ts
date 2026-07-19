import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  extractSentMessageId,
} from "@/lib/services/evolution-api";
import { readNotifyConfig } from "@/lib/services/solicitacoes-notify-config";
import { unitShort } from "@/lib/stock-units";

interface ListItem { name: string; qty: number; unit?: string | null }
interface NotifyBody {
  shipName: string;
  team?: string | null;
  materials: ListItem[];
  rancho?: ListItem[];
  sentBy?: string | null;
}

const TEAM_LABEL: Record<string, string> = {
  EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3",
};

// Lista de embarque da equipe: materiais do kit + comida do Rancho, com as
// quantidades que vão pro navio. Vai pro grupo escolhido em Mensagens.
function buildMessage(b: NotifyBody): string {
  const team = b.team ? ` · ${TEAM_LABEL[b.team] || b.team}` : "";
  const fmtQty = (q: number) => (Number.isInteger(q) ? String(q) : String(q).replace(".", ","));
  // "10 kg" / "25 un" — a unidade vem do cadastro do item no Almoxarifado.
  const line = (i: ListItem) => {
    const u = unitShort(i.unit);
    return `• ${i.name} — ${fmtQty(i.qty)}${u ? ` ${u}` : ""}`;
  };
  const mat = (b.materials || []).map(line);
  const ran = (b.rancho || []).map(line);
  const by = b.sentBy?.trim() ? `\n👤 Enviado por: ${b.sentBy.trim()}` : "";
  return (
    `📦 *Lista de embarque*\n\n` +
    `🚢 Navio: *${b.shipName}*${team}\n` +
    (mat.length ? `\n🧰 *Materiais (${mat.length})*\n${mat.join("\n")}\n` : "") +
    (ran.length ? `\n🛒 *Rancho (${ran.length})*\n${ran.join("\n")}\n` : "") +
    by
  );
}

// POST /api/embarque/notify — posta a lista de embarque no(s) grupo(s)
// configurado(s) em Mensagens › "Lista de embarque". Best-effort: sempre 200.
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

  if (!body.shipName || !Array.isArray(body.materials)) {
    return NextResponse.json({ error: "shipName e materials são obrigatórios" }, { status: 400 });
  }
  if (body.materials.length === 0 && (!body.rancho || body.rancho.length === 0)) {
    return NextResponse.json({ status: "skipped", sent: 0, warning: "Lista vazia — nada pra enviar." }, { status: 200 });
  }

  const { embarqueLista: cfg } = await readNotifyConfig();
  if (!cfg.enabled) {
    return NextResponse.json({
      status: "skipped",
      sent: 0,
      skipped: "Envio da lista desativado — ligue em Mensagens › Avisos, card \"Lista de embarque\".",
    }, { status: 200 });
  }
  if (cfg.groups.length === 0) {
    return NextResponse.json({
      status: "skipped",
      sent: 0,
      warning: "Nenhum grupo configurado — escolha um em Mensagens › Avisos, card \"Lista de embarque\".",
    }, { status: 200 });
  }

  const message = buildMessage(body);
  const groupResults: { name: string; ok: boolean; error?: string }[] = [];
  for (const g of cfg.groups) {
    const groupName = g.label || g.jid;
    try {
      const sentResult = await sendWhatsappTextToGroup(g.jid, message);
      groupResults.push({ name: groupName, ok: true });
      try {
        await prisma.whatsappMessage.create({
          data: {
            message_id: extractSentMessageId(sentResult) ?? `embarque-${g.jid}-${Date.now()}`,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: g.jid,
            from_me: true,
            push_name: groupName,
            message_type: "conversation",
            text: message,
            timestamp_ms: BigInt(Date.now()),
            sent_by_user_id: session.user.id || null,
            raw_event: { source: "embarque-lista", shipName: body.shipName },
          },
        });
      } catch (stubErr) {
        console.warn("[embarque/notify] stub insert failed:", (stubErr as Error).message);
      }
    } catch (err) {
      groupResults.push({ name: groupName, ok: false, error: (err as Error).message });
    }
  }

  const sent = groupResults.filter((r) => r.ok).length;
  if (sent === 0) {
    return NextResponse.json({
      status: "error",
      sent: 0,
      warning: `Falha ao enviar pro(s) grupo(s): ${groupResults.map((g) => `${g.name} (${g.error})`).join("; ")}`,
      results: groupResults,
    }, { status: 200 });
  }
  return NextResponse.json({
    status: "ok",
    sent,
    group: groupResults.filter((r) => r.ok).map((r) => r.name).join(", "),
    results: groupResults,
  }, { status: 200 });
}
