import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { actorCanAccessJob, getReportActor, parseKind } from "@/lib/report-scope";
import { loadPhotoBytes } from "@/lib/photo-storage";
import {
  extractSentMessageId,
  isEvolutionConfigured,
  normalizeBRNumber,
  sendWhatsappMediaToGroup,
  sendWhatsappMediaToNumber,
  sendWhatsappText,
  sendWhatsappTextToGroup,
} from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

// POST /api/relatorios/[jobId]/fotos/whatsapp — manda UMA mensagem do bloco de
// fotos pro WhatsApp do sistema (Evolution, a mesma instância da aba Conversas).
//
//   { kind, to, text }            → mensagem de texto (abertura do bloco)
//   { kind, to, photoId, caption } → a foto em si, com legenda
//
// A tela chama uma vez por foto, em sequência, e mostra o progresso — assim um
// erro numa foto não derruba as outras. `to` é um número (DM) ou o JID de um
// grupo (…@g.us). Os bytes da foto saem do Bucket pelo backend (o bucket é
// privado, o Evolution não conseguiria baixar por URL).
//
// Permissão: a mesma da aba Fotos (getReportActor + actorCanAccessJob) — quem
// vê as fotos do navio pode mandar; SUPERVISOR só nos navios dele. A foto tem
// que ser deste navio (job), venha do relatório pedido ou de um irmão que
// divide os blocos do ciclo da operação.
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "WhatsApp não configurado no sistema." }, { status: 503 });
  }

  const { jobId } = await params;
  let body: { kind?: unknown; to?: string; text?: string; photoId?: number; caption?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const kind = parseKind(body.kind);
  if (!kind) return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  if (!(await actorCanAccessJob(actor, jobId, kind))) {
    return NextResponse.json({ error: "Sem permissão neste navio" }, { status: 403 });
  }

  const to = (body.to || "").trim();
  if (!to) return NextResponse.json({ error: "Informe o destinatário." }, { status: 400 });
  const isGroup = to.endsWith("@g.us");
  const number = isGroup ? "" : normalizeBRNumber(to);
  if (!isGroup && number.length < 12) {
    return NextResponse.json({ error: "Número inválido. Use DDD + número." }, { status: 400 });
  }
  const remoteJid = isGroup ? to : `${number}@s.whatsapp.net`;

  // Cadeado da aba Conversas: conversa travada não recebe envio manual.
  const locked = await prisma.lockedConversation.findFirst({
    where: { remote_jid: { in: isGroup ? [to] : [remoteJid, `${number}@lid`] } },
    select: { remote_jid: true },
  });
  if (locked) {
    return NextResponse.json(
      { error: "Conversa bloqueada para envio (cadeado ativo). Destrave na aba Conversas." },
      { status: 423 }
    );
  }

  const label = (body.label || "").trim() || null;
  const actorId = actor.userId;
  const instanceName = process.env.EVOLUTION_INSTANCE || "default";

  // Grava a mensagem enviada pra conversa aparecer/atualizar na aba Conversas
  // (o id real do WhatsApp permite "apagar para todos" e carregar a mídia
  // depois). Não-fatal: a mensagem já saiu.
  async function persist(result: unknown, data: { message_type: string; text: string | null; media_mimetype?: string }) {
    try {
      const messageId = extractSentMessageId(result) ?? `relatorio-fotos-${Date.now()}`;
      await prisma.whatsappMessage.upsert({
        where: { unique_message: { instance_name: instanceName, message_id: messageId, remote_jid: remoteJid } },
        update: { text: data.text },
        create: {
          message_id: messageId,
          instance_name: instanceName,
          remote_jid: remoteJid,
          from_me: true,
          push_name: label,
          message_type: data.message_type,
          text: data.text,
          media_mimetype: data.media_mimetype ?? null,
          timestamp_ms: BigInt(Date.now()),
          sent_by_user_id: actorId,
          raw_event: { source: "relatorio-fotos", job_id: jobId, kind },
        },
      });
    } catch (err) {
      console.warn("[relatorios/fotos/whatsapp] stub insert failed:", (err as Error).message);
    }
  }

  // ── Texto (abertura do bloco) ──────────────────────────────────────────
  if (body.photoId === undefined || body.photoId === null) {
    const text = (body.text || "").trim();
    if (!text) return NextResponse.json({ error: "Mensagem vazia." }, { status: 400 });
    try {
      const result = isGroup ? await sendWhatsappTextToGroup(to, text) : await sendWhatsappText(number, text);
      await persist(result, { message_type: "conversation", text });
      return NextResponse.json({ data: { ok: true } });
    } catch (err) {
      return NextResponse.json({ error: friendlyEvolutionError((err as Error).message) }, { status: 502 });
    }
  }

  // ── Foto ────────────────────────────────────────────────────────────────
  const photoId = Number(body.photoId);
  if (!Number.isInteger(photoId)) return NextResponse.json({ error: "Foto inválida." }, { status: 400 });
  const photo = await prisma.shipReportPhoto.findUnique({
    where: { id: photoId },
    select: {
      id: true,
      storage_key: true,
      image_data: true,
      mime_type: true,
      reports: { select: { job_id: true } },
    },
  });
  if (!photo || photo.reports.job_id !== jobId) {
    return NextResponse.json({ error: "Foto não encontrada neste navio." }, { status: 404 });
  }
  const image = await loadPhotoBytes(photo);
  if (!image) return NextResponse.json({ error: "Imagem não encontrada." }, { status: 404 });

  const caption = (body.caption || "").trim();
  const dataUrl = `data:${image.mime};base64,${image.bytes.toString("base64")}`;
  const ext = image.mime === "image/png" ? "png" : image.mime === "image/webp" ? "webp" : "jpg";
  const fileName = `foto-${photo.id}.${ext}`;
  try {
    const result = isGroup
      ? await sendWhatsappMediaToGroup(to, dataUrl, caption, fileName)
      : await sendWhatsappMediaToNumber(number, dataUrl, caption, fileName);
    await persist(result, { message_type: "imageMessage", text: caption || null, media_mimetype: image.mime });
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    return NextResponse.json({ error: friendlyEvolutionError((err as Error).message) }, { status: 502 });
  }
}
