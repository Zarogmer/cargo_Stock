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
// foi registrada e o item lançado no Estoque.
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

  const message = buildMessage(body);
  const image = body.imageUrl?.trim() || null;

  // Resolve os grupos-alvo: os configurados pelo usuário ou, na falta, o
  // resolvedor por nome (default "Compras"). Sem nenhum, não dá pra mirar.
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
      warning: `Nenhum grupo configurado. Escolha um ou mais grupos em Mensagens › Avisos de Solicitações e Compras, ou crie o grupo "${name}" no WhatsApp e rode "Sincronizar grupos" na aba Conversas.`,
    }, { status: 200 });
  }

  // Envia pra CADA grupo. Com imagem: manda a FOTO com a mensagem como legenda;
  // se a mídia falhar (Evolution rejeita o base64, etc.), cai pro texto puro pra
  // pelo menos a info chegar. Sem imagem: texto direto. Cada grupo ganha também
  // um stub no histórico (aba Conversas). Tudo não-fatal.
  let withPhoto = false;
  let photoError: string | null = null;
  const groupResults: { name: string; ok: boolean; error?: string }[] = [];
  for (const g of targetGroups) {
    const groupName = g.label || g.jid;
    let sentResult: unknown;
    try {
      if (image) {
        try {
          sentResult = await sendWhatsappMediaToGroup(g.jid, image, message);
          withPhoto = true;
        } catch (mediaErr) {
          photoError = (mediaErr as Error).message;
          console.warn(`[notify-compras] foto falhou pro grupo ${groupName}, caindo pro texto:`, photoError);
          sentResult = await sendWhatsappTextToGroup(g.jid, message);
        }
      } else {
        sentResult = await sendWhatsappTextToGroup(g.jid, message);
      }
      groupResults.push({ name: groupName, ok: true });
      try {
        await prisma.whatsappMessage.create({
          data: {
            // id REAL do WhatsApp (key.id) → permite "apagar para todos" depois.
            message_id: extractSentMessageId(sentResult) ?? `compras-concluida-${g.jid}-${Date.now()}`,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: g.jid,
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
    } catch (err) {
      groupResults.push({ name: groupName, ok: false, error: (err as Error).message });
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
  const okGroups = groupResults.filter((r) => r.ok);
  const failedGroups = groupResults.filter((r) => !r.ok);

  if (okGroups.length === 0) {
    // Todos os grupos falharam: mantém o formato que o frontend exibe no toast
    // (sent = 0 + warning). As DMs, se houver, vão em dmResults.
    return NextResponse.json({
      status: "error",
      sent: 0,
      warning: `Falha ao enviar pro(s) grupo(s): ${failedGroups.map((g) => `${g.name} (${g.error})`).join("; ")}`,
      ...(dmResults.length ? { dmSent, dmResults } : {}),
    }, { status: 200 });
  }

  // `sent` = quantos grupos receberam; `group` lista os nomes (o toast usa isso).
  return NextResponse.json({
    status: "ok",
    sent: okGroups.length,
    group: okGroups.map((g) => g.name).join(", "),
    withPhoto,
    ...(photoError && { photoError }),
    ...(failedGroups.length ? { groupErrors: failedGroups.map((g) => `${g.name} (${g.error})`) } : {}),
    ...(dmResults.length ? { dmSent, dmResults } : {}),
  });
}
