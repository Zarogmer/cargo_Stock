import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  sendWhatsappMediaToGroup,
} from "@/lib/services/evolution-api";
import { getComprasGroupJid, comprasGroupName } from "@/lib/services/compras-group";

interface NotifyBody {
  toolName: string;
  quantity?: number;
  value?: number | null;
  supplier?: string | null;
  requestedBy?: string | null;
  concludedBy?: string | null;
  productUrl?: string | null;
  imageUrl?: string | null;
}

function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Mensagem enviada ao grupo de Compras quando uma solicitação é concluída
// (aprovada) — a compra já foi registrada e o item lançado no Estoque.
function buildMessage(b: NotifyBody): string {
  const qty = b.quantity && b.quantity > 1 ? ` (x${b.quantity})` : "";
  const value = b.value != null && Number(b.value) > 0 ? `💰 Valor: ${formatBRL(Number(b.value))}\n` : "";
  const supplier = b.supplier?.trim() ? `🏬 Fornecedor: ${b.supplier.trim()}\n` : "";
  const requestedBy = b.requestedBy?.trim() ? `👤 Solicitado por: ${b.requestedBy.trim()}\n` : "";
  const concludedBy = b.concludedBy?.trim() ? `✔️ Aprovado por: ${b.concludedBy.trim()}\n` : "";
  const link = b.productUrl?.trim() ? `🔗 ${b.productUrl.trim()}\n` : "";
  return (
    `✅ *Compra aprovada*\n\n` +
    `📦 Produto: *${b.toolName}*${qty}\n` +
    value +
    supplier +
    requestedBy +
    concludedBy +
    link +
    `\nRegistrada no Controle de Compras e lançada no Estoque. 📦`
  );
}

// POST /api/solicitacoes/notify-compras
// Best-effort: avisa o grupo "Compras" no WhatsApp quando uma solicitação é
// concluída. NUNCA é fatal pro fluxo de conclusão (a compra e o estoque já
// foram gravados antes desta chamada) — sempre devolve 200, com um resumo do
// que aconteceu pro frontend exibir no toast.
//
// O grupo-alvo é resolvido por NOME EXATO ("Compras" por padrão), de propósito
// pra não acertar o grupo oficial "Compras Cargo Ships" (ver compras-group.ts).
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

  if (!body.toolName) {
    return NextResponse.json({ error: "Campo toolName obrigatório" }, { status: 400 });
  }

  const groupName = comprasGroupName();
  const jid = await getComprasGroupJid();
  if (!jid) {
    // Grupo ainda não visto pelo app — não dá pra mirar. Não é erro fatal.
    return NextResponse.json({
      status: "skipped",
      sent: 0,
      warning: `Grupo "${groupName}" não encontrado. Crie/abra o grupo no WhatsApp e rode "Sincronizar grupos" na aba Conversas.`,
    }, { status: 200 });
  }

  const message = buildMessage(body);
  const image = body.imageUrl?.trim() || null;

  // Com imagem: manda a FOTO com a mensagem como legenda (uma mensagem só).
  // Se a mídia falhar (Evolution rejeita o base64, etc.), cai pro texto puro
  // pra pelo menos a info chegar. Sem imagem: texto direto.
  let withPhoto = false;
  try {
    if (image) {
      try {
        await sendWhatsappMediaToGroup(jid, image, message);
        withPhoto = true;
      } catch (mediaErr) {
        console.warn("[notify-compras] envio de foto falhou, caindo pro texto:", (mediaErr as Error).message);
        await sendWhatsappTextToGroup(jid, message);
      }
    } else {
      await sendWhatsappTextToGroup(jid, message);
    }
  } catch (err) {
    return NextResponse.json({
      status: "error",
      sent: 0,
      warning: `Falha ao enviar pro grupo "${groupName}": ${(err as Error).message}`,
    }, { status: 200 });
  }

  // Persiste a mensagem no histórico pra aparecer na aba Conversas do grupo
  // (mesmo padrão das mensagens de boas-vindas/escala). Não-fatal.
  try {
    await prisma.whatsappMessage.create({
      data: {
        message_id: `compras-concluida-${jid}-${Date.now()}`,
        instance_name: process.env.EVOLUTION_INSTANCE || "default",
        remote_jid: jid,
        from_me: true,
        push_name: groupName,
        message_type: "conversation",
        text: message,
        timestamp_ms: BigInt(Date.now()),
        sent_by_user_id: session.user.id || null,
        raw_event: { source: "solicitacoes-concluida", toolName: body.toolName },
      },
    });
  } catch (stubErr) {
    console.warn("[notify-compras] stub insert failed:", (stubErr as Error).message);
  }

  return NextResponse.json({ status: "ok", sent: 1, group: groupName, withPhoto });
}
