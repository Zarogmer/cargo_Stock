import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappText,
  sendWhatsappTextToGroup,
  extractSentMessageId,
  normalizeBRNumber,
} from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

// Enviar pra grupo expõe operação interna (boletins de estoque/prontidão) e
// segue o mesmo gate das outras rotas de grupo. DM continua liberado pra
// qualquer usuário logado (comportamento histórico).
const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// POST { to: string, text: string, label?: string } — envia um texto via Evolution.
// Se `to` termina em "@g.us" é um grupo (exige papel em ALLOWED_ROLES); senão é
// DM pra um número. Nos DOIS casos grava um stub da mensagem enviada pra a
// conversa aparecer/atualizar na aba Conversas (sem isso, a conversa com um
// contato novo — ex.: fornecedor — só surgiria quando ELE respondesse).
// Requer autenticação. Retorna 503 quando a Evolution não está configurada.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }

  let body: { to?: string; text?: string; label?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const to = body.to?.trim();
  const text = body.text?.trim();
  if (!to || !text) {
    return NextResponse.json({ error: "Campos 'to' e 'text' são obrigatórios" }, { status: 400 });
  }

  // Cadeado da aba Conversas: recusa envio manual pra conversas travadas. `to`
  // pode ser o JID (grupo) ou só o número (DM) — cobre as duas formas.
  const lockedCandidates = to.includes("@") ? [to] : [to, `${to}@s.whatsapp.net`, `${to}@lid`];
  const locked = await prisma.lockedConversation.findFirst({
    where: { remote_jid: { in: lockedCandidates } },
    select: { remote_jid: true },
  });
  if (locked) {
    return NextResponse.json({ error: "Conversa bloqueada para envio (cadeado ativo). Destrave na aba Conversas pra mandar mensagem." }, { status: 423 });
  }

  const isGroup = to.endsWith("@g.us");

  if (isGroup) {
    if (!ALLOWED_ROLES.includes(session.user.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    try {
      const result = await sendWhatsappTextToGroup(to, text);
      // Persiste a mensagem pra aparecer em Conversas (mesmo padrão de
      // groups/route.ts e escalacao/notify). Falha aqui é não-fatal: a
      // mensagem já saiu pro grupo.
      try {
        await prisma.whatsappMessage.create({
          data: {
            // id REAL do WhatsApp (key.id) → permite "apagar para todos" depois;
            // cai num id sintético só se o Evolution não devolver o id.
            message_id: extractSentMessageId(result) ?? `mensagens-group-${to}-${Date.now()}`,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: to,
            from_me: true,
            push_name: body.label?.trim() || null,
            message_type: "conversation",
            text,
            timestamp_ms: BigInt(Date.now()),
            sent_by_user_id: session.user.id || null,
            raw_event: { source: "mensagens-group" },
          },
        });
      } catch (stubErr) {
        console.warn("[send] group stub insert failed:", (stubErr as Error).message);
      }
      return NextResponse.json({ success: true, result });
    } catch (err) {
      return NextResponse.json({ error: friendlyEvolutionError((err as Error).message) }, { status: 502 });
    }
  }

  try {
    const result = await sendWhatsappText(to, text);
    // Persiste a mensagem enviada (DM) pra a conversa aparecer/atualizar na aba
    // Conversas. Sem isso, a conversa com o fornecedor/contato só surgiria depois
    // que ELE respondesse (o webhook grava as recebidas). Usa o id REAL do
    // WhatsApp (key.id) e faz upsert pela chave única — se o webhook reenviar o
    // mesmo evento fromMe, casa pelo id+jid e NÃO duplica. Não-fatal: a mensagem
    // já saiu, então só logamos se o stub falhar.
    try {
      const number = normalizeBRNumber(to);
      const remoteJid = `${number}@s.whatsapp.net`;
      const instanceName = process.env.EVOLUTION_INSTANCE || "default";
      const messageId = extractSentMessageId(result) ?? `dm-${number}-${Date.now()}`;
      await prisma.whatsappMessage.upsert({
        where: { unique_message: { instance_name: instanceName, message_id: messageId, remote_jid: remoteJid } },
        update: { text },
        create: {
          message_id: messageId,
          instance_name: instanceName,
          remote_jid: remoteJid,
          from_me: true,
          push_name: body.label?.trim() || null,
          message_type: "conversation",
          text,
          timestamp_ms: BigInt(Date.now()),
          sent_by_user_id: session.user.id || null,
          raw_event: { source: "dm-send" },
        },
      });
    } catch (stubErr) {
      console.warn("[send] DM stub insert failed:", (stubErr as Error).message);
    }
    return NextResponse.json({ success: true, result });
  } catch (err) {
    return NextResponse.json({ error: friendlyEvolutionError((err as Error).message) }, { status: 502 });
  }
}
