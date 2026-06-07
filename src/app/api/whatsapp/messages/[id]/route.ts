import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteWhatsappMessageForEveryone, isEvolutionConfigured } from "@/lib/services/evolution-api";
import { whatsappBus } from "@/lib/services/whatsapp-bus";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// Tipos que NÃO são mensagens reais do WhatsApp (pílulas de evento de grupo,
// avisos do sistema, ou já apagadas) — "apagar para todos" não se aplica.
const NON_REVOCABLE_TYPES = new Set(["systemNotice", "groupParticipantUpdate", "deletedMessage"]);

// Prefixos de message_id sintéticos (stubs antigos, criados antes de guardarmos
// o id REAL do WhatsApp no envio). Não dá pra revogar esses no WhatsApp — só
// apagar localmente. Ids reais do WhatsApp são tipo "BAE5..." / "3EB0...".
const SYNTHETIC_ID_PREFIXES = [
  "system-", "gp-", "noid-", "scheduled-", "embarque-broadcast-",
  "welcome-", "solicitacao-nova-", "compras-concluida-", "escala-", "mensagens-group-",
];

function isSyntheticId(id: string | null): boolean {
  if (!id) return true;
  return SYNTHETIC_ID_PREFIXES.some((p) => id.startsWith(p));
}

// JID de quem enviou (key.participant) no payload bruto — necessário pra revogar
// mensagem de OUTRA pessoa num grupo (quando o número conectado é admin).
function extractParticipant(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const data = (raw as Record<string, unknown>).data;
  const key = data && typeof data === "object" ? (data as Record<string, unknown>).key : undefined;
  const p = key && typeof key === "object" ? (key as Record<string, unknown>).participant : undefined;
  return typeof p === "string" && p ? p : null;
}

// Avisa os outros clientes conectados (SSE) pra recarregarem a conversa — assim
// a exclusão aparece na hora pra todo mundo que está com a aba aberta.
function emitChange(remoteJid: string) {
  try {
    whatsappBus.emit("message", { type: "message", remote_jid: remoteJid });
  } catch {
    // best-effort: o polling de 30s cobre se o bus falhar.
  }
}

// DELETE /api/whatsapp/messages/[id]?scope=everyone|me
//   scope=everyone (padrão): revoga no WhatsApp (apaga pra todos) e marca a
//     linha como tombstone ("deletedMessage") — o conteúdo some do banco também
//     e a UI mostra "Mensagem apagada".
//   scope=me: remove só a linha local; o WhatsApp de todo mundo fica intacto.
// `id` é o uuid da nossa tabela (WhatsappMessage.id), não o id do WhatsApp.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const scope = (req.nextUrl.searchParams.get("scope") || "everyone").toLowerCase();

  const msg = await prisma.whatsappMessage.findUnique({
    where: { id },
    select: {
      id: true, message_id: true, remote_jid: true,
      from_me: true, message_type: true, raw_event: true,
    },
  });
  if (!msg) return NextResponse.json({ error: "Mensagem não encontrada." }, { status: 404 });

  // "Apagar para mim": remove só do nosso banco (não toca no WhatsApp).
  if (scope === "me") {
    await prisma.whatsappMessage.delete({ where: { id } });
    emitChange(msg.remote_jid);
    return NextResponse.json({ status: "ok", scope: "me" });
  }

  // "Apagar para todos" (revoke). Precisa do id real do WhatsApp e ser uma
  // mensagem de verdade (não pílula de sistema / já apagada).
  if (NON_REVOCABLE_TYPES.has(msg.message_type) || isSyntheticId(msg.message_id)) {
    return NextResponse.json(
      {
        error: "Esta mensagem não pode ser apagada para todos (foi enviada antes deste recurso ou é um evento do sistema). Use \"Apagar para mim\".",
        code: "NOT_REVOCABLE",
      },
      { status: 422 },
    );
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "WhatsApp não configurado." }, { status: 503 });
  }

  try {
    await deleteWhatsappMessageForEveryone({
      remoteJid: msg.remote_jid,
      messageId: msg.message_id as string,
      fromMe: msg.from_me,
      // participant só importa pra revogar msg de terceiro em grupo (bot admin).
      participant: msg.remote_jid.endsWith("@g.us") && !msg.from_me ? extractParticipant(msg.raw_event) : null,
    });
  } catch (err) {
    // WhatsApp recusou: mensagem de outra pessoa numa DM, bot não é admin do
    // grupo, ou passou do prazo do WhatsApp. Oferece o fallback "apagar pra mim".
    return NextResponse.json(
      {
        error: `Não deu pra apagar para todos no WhatsApp: ${(err as Error).message}. Você ainda pode "Apagar para mim".`,
        code: "REVOKE_FAILED",
      },
      { status: 502 },
    );
  }

  // Revogou no WhatsApp → vira tombstone aqui. Mantém message_id/remote_jid pro
  // guard do webhook não recriar a mensagem num replay do Evolution.
  const deletedBy =
    (session.user as { name?: string | null }).name ||
    (session.user as { email?: string | null }).email ||
    null;
  await prisma.whatsappMessage.update({
    where: { id },
    data: {
      message_type: "deletedMessage",
      text: null,
      media_mimetype: null,
      media_filename: null,
      raw_event: { deleted: true, deleted_by: deletedBy },
    },
  });

  emitChange(msg.remote_jid);
  return NextResponse.json({ status: "ok", scope: "everyone" });
}
