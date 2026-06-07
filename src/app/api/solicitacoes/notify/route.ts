import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappText,
  sendWhatsappMediaToNumber,
  sendWhatsappTextToGroup,
  sendWhatsappMediaToGroup,
  extractSentMessageId,
} from "@/lib/services/evolution-api";
import { readNotifyConfig, normalizeFunctionName } from "@/lib/services/solicitacoes-notify-config";

interface NotifyBody {
  toolName: string;
  quantity?: number;
  reason?: string;
  requestedBy: string;
  value?: number | null;
  supplier?: string | null;
  productUrl?: string | null;
  imageUrl?: string | null;
}

function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Mensagem enviada (pelo número da Cargo no WhatsApp) quando uma nova solicitação
// de compra é registrada.
function buildMessage(b: NotifyBody): string {
  const qty = b.quantity && b.quantity > 1 ? ` (x${b.quantity})` : "";
  const reason = b.reason?.trim() ? `📝 Motivo: ${b.reason.trim()}\n` : "";
  const value = b.value != null && Number(b.value) > 0 ? `💰 Valor: ${formatBRL(Number(b.value))}\n` : "";
  const supplier = b.supplier?.trim() ? `🏬 Fornecedor: ${b.supplier.trim()}\n` : "";
  const link = b.productUrl?.trim() ? `🔗 ${b.productUrl.trim()}\n` : "";
  return (
    `🛒 *Nova solicitação de compra*\n\n` +
    `📦 Produto: *${b.toolName}*${qty}\n` +
    value +
    supplier +
    reason +
    `👤 Solicitado por: ${b.requestedBy}\n` +
    link +
    `\nAcesse o Cargo Stock para aprovar ou recusar.`
  );
}

// POST /api/solicitacoes/notify
// Best-effort: avisa por WhatsApp quando uma nova solicitação é criada. Os
// destinos (funções que recebem DM e/ou um grupo) vêm da configuração em
// app_settings — ver src/lib/services/solicitacoes-notify-config.ts. O default
// preserva o comportamento antigo: DM pra todo colaborador com função SUPERVISOR.
// Nunca bloqueia a criação da solicitação — devolve 200 com um resumo por destino.
//
// Qualquer usuário autenticado pode disparar: a solicitação pode ser feita até
// por um funcionário, e mesmo assim os destinos precisam ser avisados.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isEvolutionConfigured()) {
    return NextResponse.json({ skipped: "Evolution API não configurada" }, { status: 200 });
  }

  let body: NotifyBody;
  try {
    body = (await request.json()) as NotifyBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (!body.toolName || !body.requestedBy) {
    return NextResponse.json({ error: "Campos obrigatórios faltando" }, { status: 400 });
  }

  const { novaSolicitacao: cfg } = await readNotifyConfig();
  const message = buildMessage(body);
  const image = body.imageUrl?.trim() || null;
  const results: { target: string; ok: boolean; error?: string }[] = [];

  // 1) DM pros colaboradores das funções configuradas. O filtro de status fica em
  // JS (e não no Prisma) pra não depender da semântica de null do `not` e nunca
  // pular um colaborador com status nulo. Match de função case-insensitive
  // (dados do RH podem vir como "Supervisor").
  const wantedFns = new Set(cfg.functions.map(normalizeFunctionName));
  if (wantedFns.size > 0) {
    const employees = (
      await prisma.employee.findMany({
        where: { role: { not: null } },
        select: { id: true, name: true, phone: true, role: true, status: true },
      })
    ).filter((e) => e.status !== "INATIVO" && wantedFns.has(normalizeFunctionName(e.role || "")));

    for (const emp of employees) {
      if (!emp.phone || emp.phone.trim().length < 10) {
        results.push({ target: `dm:${emp.name}`, ok: false, error: "sem telefone válido" });
        continue;
      }
      try {
        // Com imagem: manda a foto com a mensagem como legenda; se a mídia falhar,
        // cai pro texto puro. Sem imagem: texto direto.
        if (image) {
          try {
            await sendWhatsappMediaToNumber(emp.phone, image, message);
          } catch (mediaErr) {
            console.warn(`[solicitacoes/notify] foto falhou pra ${emp.name}, fallback texto:`, (mediaErr as Error).message);
            await sendWhatsappText(emp.phone, message);
          }
        } else {
          await sendWhatsappText(emp.phone, message);
        }
        results.push({ target: `dm:${emp.name}`, ok: true });
      } catch (err) {
        results.push({ target: `dm:${emp.name}`, ok: false, error: (err as Error).message });
      }
    }
  }

  // 2) Se um grupo foi configurado, também avisa o grupo (mesmo fallback foto→texto).
  if (cfg.groupJid) {
    const groupTarget = `group:${cfg.groupLabel || cfg.groupJid}`;
    try {
      let sent: unknown;
      if (image) {
        try {
          sent = await sendWhatsappMediaToGroup(cfg.groupJid, image, message);
        } catch (mediaErr) {
          console.warn("[solicitacoes/notify] foto falhou pro grupo, fallback texto:", (mediaErr as Error).message);
          sent = await sendWhatsappTextToGroup(cfg.groupJid, message);
        }
      } else {
        sent = await sendWhatsappTextToGroup(cfg.groupJid, message);
      }
      results.push({ target: groupTarget, ok: true });

      // Stub no histórico pra aparecer na aba Conversas do grupo (best-effort).
      try {
        await prisma.whatsappMessage.create({
          data: {
            // id REAL do WhatsApp (key.id) → permite "apagar para todos" depois.
            message_id: extractSentMessageId(sent) ?? `solicitacao-nova-${cfg.groupJid}-${Date.now()}`,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: cfg.groupJid,
            from_me: true,
            push_name: cfg.groupLabel || null,
            message_type: "conversation",
            text: message,
            timestamp_ms: BigInt(Date.now()),
            sent_by_user_id: session.user.id || null,
            raw_event: { source: "solicitacoes-nova", toolName: body.toolName },
          },
        });
      } catch (stubErr) {
        console.warn("[solicitacoes/notify] stub insert failed:", (stubErr as Error).message);
      }
    } catch (err) {
      results.push({ target: groupTarget, ok: false, error: (err as Error).message });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  return NextResponse.json({ status: "ok", sent, total: results.length, results });
}
