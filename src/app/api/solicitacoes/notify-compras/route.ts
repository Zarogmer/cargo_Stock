import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  sendWhatsappMediaToGroup,
  sendWhatsappText,
  sendWhatsappMediaToNumber,
  extractSentMessageId,
} from "@/lib/services/evolution-api";
import { getComprasGroupJid, comprasGroupName } from "@/lib/services/compras-group";
import { readNotifyConfig, normalizeFunctionName } from "@/lib/services/solicitacoes-notify-config";
import { isMercadoLivreLink, fetchMlItem } from "@/lib/services/mercado-livre";

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

// Mensagem enviada quando uma solicitação é concluída (aprovada) — a compra já
// foi registrada e o item lançado no Estoque. `keywords` (palavras-chave oficiais
// do Mercado Livre) entra logo abaixo do produto quando disponível.
function buildMessage(b: NotifyBody, keywords?: string | null): string {
  const qty = b.quantity && b.quantity > 1 ? ` (x${b.quantity})` : "";
  const kw = keywords?.trim() ? `🔑 Palavras-chave: ${keywords.trim()}\n` : "";
  const value = b.value != null && Number(b.value) > 0 ? `💰 Valor: ${formatBRL(Number(b.value))}\n` : "";
  const supplier = b.supplier?.trim() ? `🏬 Fornecedor: ${b.supplier.trim()}\n` : "";
  const requestedBy = b.requestedBy?.trim() ? `👤 Solicitado por: ${b.requestedBy.trim()}\n` : "";
  const concludedBy = b.concludedBy?.trim() ? `✔️ Aprovado por: ${b.concludedBy.trim()}\n` : "";
  const link = b.productUrl?.trim() ? `🔗 ${b.productUrl.trim()}\n` : "";
  return (
    `✅ *Compra aprovada*\n\n` +
    `📦 Produto: *${b.toolName}*${qty}\n` +
    kw +
    value +
    supplier +
    requestedBy +
    concludedBy +
    link +
    `\nRegistrada no Controle de Compras e lançada no Estoque. 📦`
  );
}

// POST /api/solicitacoes/notify-compras
// Best-effort: avisa quando uma solicitação é concluída. O grupo-alvo vem da
// configuração (app_settings); na falta, cai no resolvedor por nome ("Compras")
// — ver src/lib/services/compras-group.ts e solicitacoes-notify-config.ts.
// Opcionalmente também manda DM pras funções configuradas. NUNCA é fatal pro
// fluxo de conclusão (a compra e o estoque já foram gravados antes desta chamada)
// — sempre devolve 200, com um resumo pro frontend exibir no toast.
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

  const { compraConcluida: cfg } = await readNotifyConfig();

  // Palavras-chave oficiais do Mercado Livre (best-effort): só quando o link é do
  // ML e a conta está conectada. Qualquer erro (não configurado, sem token, item
  // removido, timeout) é ignorado — o aviso sai sem a linha de palavras-chave.
  let keywords: string | null = null;
  if (isMercadoLivreLink(body.productUrl)) {
    try {
      const item = await fetchMlItem(body.productUrl!.trim());
      if (item?.keywords) keywords = item.keywords;
    } catch (err) {
      console.warn("[notify-compras] palavras-chave do ML indisponíveis:", (err as Error).message);
    }
  }

  const message = buildMessage(body, keywords);
  const image = body.imageUrl?.trim() || null;

  // Resolve o grupo-alvo: o configurado pelo usuário ou, na falta, o resolvedor
  // por nome (default "Compras"). Se nenhum estiver disponível, não dá pra mirar.
  let jid = cfg.groupJid;
  let groupLabel = cfg.groupLabel || "";
  if (!jid) {
    jid = await getComprasGroupJid();
    groupLabel = comprasGroupName();
    if (!jid) {
      const name = comprasGroupName();
      return NextResponse.json({
        status: "skipped",
        sent: 0,
        warning: `Grupo "${name}" não encontrado. Crie/abra o grupo no WhatsApp e rode "Sincronizar grupos" na aba Conversas.`,
      }, { status: 200 });
    }
  }
  const groupName = groupLabel || jid;

  // Envio pro grupo. Com imagem: manda a FOTO com a mensagem como legenda; se a
  // mídia falhar (Evolution rejeita o base64, etc.), cai pro texto puro pra pelo
  // menos a info chegar. Sem imagem: texto direto.
  let withPhoto = false;
  let photoError: string | null = null;
  let groupOk = false;
  let groupError: string | null = null;
  let sentResult: unknown;
  try {
    if (image) {
      try {
        sentResult = await sendWhatsappMediaToGroup(jid, image, message);
        withPhoto = true;
      } catch (mediaErr) {
        photoError = (mediaErr as Error).message;
        console.warn("[notify-compras] envio de foto falhou, caindo pro texto:", photoError);
        sentResult = await sendWhatsappTextToGroup(jid, message);
      }
    } else {
      sentResult = await sendWhatsappTextToGroup(jid, message);
    }
    groupOk = true;
  } catch (err) {
    groupError = (err as Error).message;
  }

  // Persiste a mensagem no histórico pra aparecer na aba Conversas do grupo
  // (mesmo padrão das mensagens de boas-vindas/escala). Não-fatal.
  if (groupOk) {
    try {
      await prisma.whatsappMessage.create({
        data: {
          // id REAL do WhatsApp (key.id) → permite "apagar para todos" depois.
          message_id: extractSentMessageId(sentResult) ?? `compras-concluida-${jid}-${Date.now()}`,
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
  }

  // Opcional: DM pros colaboradores das funções configuradas (mesmo padrão do
  // /api/solicitacoes/notify). Filtro de status em JS pra tolerar status nulo.
  const wantedFns = new Set(cfg.functions.map(normalizeFunctionName));
  const dmResults: { target: string; ok: boolean; error?: string }[] = [];
  if (wantedFns.size > 0) {
    const employees = (
      await prisma.employee.findMany({
        where: { role: { not: null } },
        select: { id: true, name: true, phone: true, role: true, status: true },
      })
    ).filter((e) => e.status !== "INATIVO" && wantedFns.has(normalizeFunctionName(e.role || "")));

    for (const emp of employees) {
      if (!emp.phone || emp.phone.trim().length < 10) {
        dmResults.push({ target: `dm:${emp.name}`, ok: false, error: "sem telefone válido" });
        continue;
      }
      try {
        if (image) {
          try {
            await sendWhatsappMediaToNumber(emp.phone, image, message);
          } catch (mediaErr) {
            console.warn(`[notify-compras] foto falhou pra ${emp.name}, fallback texto:`, (mediaErr as Error).message);
            await sendWhatsappText(emp.phone, message);
          }
        } else {
          await sendWhatsappText(emp.phone, message);
        }
        dmResults.push({ target: `dm:${emp.name}`, ok: true });
      } catch (err) {
        dmResults.push({ target: `dm:${emp.name}`, ok: false, error: (err as Error).message });
      }
    }
  }

  const dmSent = dmResults.filter((r) => r.ok).length;

  if (!groupOk) {
    // Grupo falhou: mantém o formato de aviso que o frontend já exibe no toast.
    // (sent = 0 pro toast continuar mostrando o warning; as DMs, se houver, vão
    // em dmResults.)
    return NextResponse.json({
      status: "error",
      sent: 0,
      warning: `Falha ao enviar pro grupo "${groupName}": ${groupError}`,
      ...(dmResults.length ? { dmSent, dmResults } : {}),
    }, { status: 200 });
  }

  // `sent` segue representando o aviso ao GRUPO (o toast do frontend é centrado
  // no grupo). As DMs opcionais vão em campos próprios.
  return NextResponse.json({
    status: "ok",
    sent: 1,
    group: groupName,
    withPhoto,
    ...(photoError && { photoError }),
    ...(dmResults.length ? { dmSent, dmResults } : {}),
  });
}
