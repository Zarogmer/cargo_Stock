import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { whatsappBus } from "@/lib/services/whatsapp-bus";
import { findGroupInfo, isEvolutionConfigured } from "@/lib/services/evolution-api";

// Evolution API posts events here whenever messages arrive (or are sent),
// connection state changes, etc. The URL is registered via /webhook/set on
// the Evolution side — see registerWebhook in evolution-api.ts.
//
// Security: we validate a shared secret passed as ?secret=... in the URL.
// Set EVOLUTION_WEBHOOK_SECRET in env on both the Cargo Stock service and the
// Evolution side (in the webhook URL).
//
// We only persist messages.upsert events for now. Other events (messages.update,
// connection.update, presence.update, etc.) are acknowledged with 200 OK so
// Evolution doesn't retry, but ignored.

interface EvolutionWebhookPayload {
  event: string;
  instance?: string;
  data?: {
    key?: {
      remoteJid?: string;
      fromMe?: boolean;
      id?: string;
      participant?: string;
    };
    pushName?: string;
    message?: Record<string, unknown>;
    messageType?: string;
    messageTimestamp?: number;
    [key: string]: unknown;
  };
}

// Extract a text representation from whatever message shape WhatsApp sent.
// WhatsApp messages can carry text in many places depending on type.
function extractText(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;
  if (typeof message.conversation === "string") return message.conversation;
  if (typeof message.extendedTextMessage === "object" && message.extendedTextMessage) {
    const ext = message.extendedTextMessage as { text?: string };
    if (ext.text) return ext.text;
  }
  // Captions for media
  const mediaWithCaption = ["imageMessage", "videoMessage", "documentMessage"] as const;
  for (const key of mediaWithCaption) {
    const m = message[key];
    if (m && typeof m === "object" && "caption" in m) {
      const cap = (m as { caption?: string }).caption;
      if (cap) return cap;
    }
  }
  return null;
}

// Garante que existe um stub "systemNotice" pro grupo, pra Conversas mostrar
// o nome real do grupo em vez do nome do último remetente. Roda só quando a
// mensagem é de grupo (@g.us) e ainda não há stub. Fetch único do subject via
// Evolution — falha silenciosa (próxima mensagem tenta de novo).
async function ensureGroupStub(jid: string, instanceName: string): Promise<void> {
  if (!jid.endsWith("@g.us")) return;
  const existing = await prisma.whatsappMessage.findFirst({
    where: {
      remote_jid: jid,
      from_me: true,
      message_type: "systemNotice",
      push_name: { not: null },
    },
    select: { id: true },
  });
  if (existing) return;
  if (!isEvolutionConfigured()) return;

  let subject: string | null = null;
  try {
    const info = await findGroupInfo(jid);
    subject = info?.subject?.trim() || null;
  } catch (err) {
    console.warn("[whatsapp-webhook] findGroupInfo failed:", jid, (err as Error).message);
    return;
  }
  if (!subject) return;

  // message_id determinístico — se duas mensagens chegarem ao mesmo tempo e
  // ambas tentarem criar o stub, o unique constraint resolve.
  try {
    await prisma.whatsappMessage.upsert({
      where: {
        unique_message: {
          instance_name: instanceName,
          message_id: `system-auto-${jid}`,
          remote_jid: jid,
        },
      },
      update: { push_name: subject },
      create: {
        message_id: `system-auto-${jid}`,
        instance_name: instanceName,
        remote_jid: jid,
        from_me: true,
        push_name: subject,
        message_type: "systemNotice",
        text: "✨ Grupo detectado",
        timestamp_ms: BigInt(Date.now()),
        raw_event: { source: "webhook-auto-stub", subject },
      },
    });
  } catch (err) {
    console.warn("[whatsapp-webhook] auto-stub upsert failed:", jid, (err as Error).message);
  }
}

// "5513999999999@s.whatsapp.net" → "5513999999999"; "abc@lid" → "abc"
function stripJidSuffix(jid: string): string {
  return jid.replace(/@.*$/, "").replace(/\D/g, "");
}

function formatBrPhone(digits: string): string {
  const local = digits.startsWith("55") ? digits.slice(2) : digits;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return digits;
}

// Tenta resolver o nome do participante. Ordem: (1) employee match pelo
// telefone, (2) lookup no histórico de mensagens (pra LIDs — quem ja falou
// no sistema fica registrado), (3) fallback pro telefone formatado ou
// rótulo genérico de LID.
async function resolveParticipantLabel(participantJid: string): Promise<{ label: string; phone: string | null; jid: string }> {
  const digits = stripJidSuffix(participantJid);
  const isLid = participantJid.endsWith("@lid") || digits.length > 13;

  // Step 1: telefone direto
  if (!isLid && digits.length >= 10 && digits.length <= 13) {
    const emp = await prisma.employee.findFirst({
      where: {
        OR: [
          { phone: { contains: digits } },
          ...(digits.startsWith("55")
            ? [{ phone: { contains: digits.slice(2) } }]
            : [{ phone: { contains: `55${digits}` } }]),
        ],
      },
      select: { name: true, phone: true },
    });
    if (emp) return { label: emp.name, phone: emp.phone, jid: participantJid };
    return { label: formatBrPhone(digits), phone: digits, jid: participantJid };
  }

  // Step 2: LID — procura o pushName / participantPn em mensagens antigas.
  // Os webhooks gravam `data.key.participant` (LID) e `data.key.participantPn` (telefone)
  // pra cada mensagem; basta achar uma desse mesmo LID.
  if (isLid) {
    // Busca por push_name conhecido (mais simples e barato que JSON path query).
    const recent = await prisma.whatsappMessage.findMany({
      where: { from_me: false, push_name: { not: null } },
      orderBy: { timestamp_ms: "desc" },
      select: { push_name: true, raw_event: true },
      take: 1500,
    });
    for (const m of recent) {
      const raw = m.raw_event as Record<string, unknown> | null;
      const data = (raw?.data ?? raw) as Record<string, unknown> | null;
      const key = (data?.key ?? null) as Record<string, unknown> | null;
      const partRaw = typeof key?.participant === "string" ? key.participant : "";
      if (!partRaw) continue;
      const partDigits = stripJidSuffix(partRaw);
      if (partDigits !== digits) continue;
      const pn = typeof key?.participantPn === "string" ? key.participantPn : "";
      const phoneDigits = pn ? stripJidSuffix(pn) : "";
      // Achou: tenta casar com employee pelo phone resolvido
      if (phoneDigits) {
        const emp = await prisma.employee.findFirst({
          where: {
            OR: [
              { phone: { contains: phoneDigits } },
              ...(phoneDigits.startsWith("55")
                ? [{ phone: { contains: phoneDigits.slice(2) } }]
                : [{ phone: { contains: `55${phoneDigits}` } }]),
            ],
          },
          select: { name: true, phone: true },
        });
        if (emp) return { label: emp.name, phone: emp.phone, jid: participantJid };
        return { label: m.push_name || formatBrPhone(phoneDigits), phone: phoneDigits, jid: participantJid };
      }
      // Sem phone resolvido mas com pushName — usa o pushName.
      if (m.push_name) return { label: m.push_name, phone: null, jid: participantJid };
    }
  }

  // Fallback genérico
  if (isLid) return { label: `Participante (#${digits.slice(-6)})`, phone: null, jid: participantJid };
  return { label: formatBrPhone(digits), phone: digits, jid: participantJid };
}

interface GroupParticipantsPayload {
  data?: {
    id?: string;            // groupJid@g.us
    participants?: string[]; // JIDs dos participantes
    action?: string;        // "add" | "remove" | "promote" | "demote"
    author?: string;        // quem fez a ação (opcional)
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function instanceNameFor(payload: EvolutionWebhookPayload): string {
  return payload.instance || process.env.EVOLUTION_INSTANCE || "default";
}

// Persiste o evento de adição/remoção/promoção como uma mensagem
// "groupParticipantUpdate" — a aba Conversas renderiza isso como uma pílula
// neutra no centro, estilo WhatsApp.
async function handleGroupParticipantsUpdate(
  payload: EvolutionWebhookPayload,
  instanceName: string,
): Promise<NextResponse> {
  const data = (payload.data || {}) as GroupParticipantsPayload["data"];
  const groupJid = (data?.id as string) || "";
  const action = String(data?.action || "").toLowerCase();
  const participants = Array.isArray(data?.participants) ? (data!.participants as string[]) : [];

  if (!groupJid.endsWith("@g.us") || participants.length === 0 || !action) {
    console.warn("[whatsapp-webhook] group.participants.update sem dados:", { groupJid, action, count: participants.length });
    return NextResponse.json({ status: "ignored", reason: "missing-fields" });
  }

  try {
    // Resolve nomes em paralelo (limite leve pra não estourar pool de conexões).
    const resolved = await Promise.all(participants.slice(0, 25).map(resolveParticipantLabel));
    const names = resolved.map((r) => r.label).join(", ");

    let text = "";
    let icon = "ℹ️";
    if (action === "add") {
      icon = "➕";
      text = participants.length === 1
        ? `${names} entrou no grupo`
        : `${names} foram adicionados ao grupo`;
    } else if (action === "remove") {
      icon = "➖";
      text = participants.length === 1
        ? `${names} saiu do grupo`
        : `${names} foram removidos do grupo`;
    } else if (action === "promote") {
      icon = "⭐";
      text = participants.length === 1
        ? `${names} virou admin`
        : `${names} viraram admins`;
    } else if (action === "demote") {
      icon = "🔻";
      text = participants.length === 1
        ? `${names} deixou de ser admin`
        : `${names} deixaram de ser admins`;
    } else {
      text = `${names} (${action})`;
    }
    text = `${icon} ${text}`;

    // Resolve quem fez a ação, se vier.
    let authorLabel: string | null = null;
    if (typeof data?.author === "string" && data.author) {
      try {
        authorLabel = (await resolveParticipantLabel(data.author)).label;
      } catch {
        // ignora — autor é só metadata
      }
    }

    const timestampMs = BigInt(Date.now());
    // ID determinístico que dedup eventos repetidos: action + participantes ordenados + timestamp arredondado
    // (Evolution às vezes manda 2x o mesmo evento; o unique constraint evita duplicar).
    const partKey = participants.map(stripJidSuffix).sort().join(",");
    const messageId = `gp-${action}-${partKey}-${Math.floor(Date.now() / 1000)}`;

    await prisma.whatsappMessage.create({
      data: {
        message_id: messageId,
        instance_name: instanceName,
        remote_jid: groupJid,
        from_me: false,
        push_name: authorLabel,
        message_type: "groupParticipantUpdate",
        text,
        timestamp_ms: timestampMs,
        raw_event: {
          action,
          participants,
          resolved: resolved.map((r) => ({ jid: r.jid, label: r.label, phone: r.phone })),
          author: data?.author || null,
          original: payload as unknown,
        } as object,
      },
    }).catch(async (err) => {
      // Se bater no unique constraint, ignora — já tinha esse evento.
      const msg = (err as Error).message;
      if (!msg.includes("Unique constraint")) {
        console.warn("[whatsapp-webhook] group participants persist failed:", msg);
      }
    });

    console.log("[whatsapp-webhook] group participants:", groupJid, action, participants.length, "→", names);

    // Fan out pra UI atualizar em tempo real
    try {
      whatsappBus.emit("message", {
        type: "message",
        remote_jid: groupJid,
        from_me: false,
        message_type: "groupParticipantUpdate",
        text,
        push_name: authorLabel,
        timestamp_ms: Number(timestampMs),
      });
    } catch (busErr) {
      console.warn("[whatsapp-webhook] bus emit failed:", (busErr as Error).message);
    }

    return NextResponse.json({ status: "ok", action, count: participants.length });
  } catch (err) {
    console.warn("[whatsapp-webhook] handleGroupParticipantsUpdate error:", (err as Error).message);
    return NextResponse.json({ status: "error", message: (err as Error).message }, { status: 500 });
  }
}

function extractMediaInfo(
  message: Record<string, unknown> | undefined,
  messageType: string | undefined,
): { mimetype: string | null; filename: string | null } {
  if (!message) return { mimetype: null, filename: null };
  const candidates = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
  for (const key of candidates) {
    const m = message[key];
    if (m && typeof m === "object") {
      const obj = m as { mimetype?: string; fileName?: string };
      return { mimetype: obj.mimetype || null, filename: obj.fileName || null };
    }
  }
  return { mimetype: messageType?.includes("Message") ? "unknown" : null, filename: null };
}

export async function POST(req: NextRequest) {
  // Validate webhook secret
  const expected = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (expected) {
    const provided = req.nextUrl.searchParams.get("secret");
    if (provided !== expected) {
      console.warn("[whatsapp-webhook] reject: bad secret (got=", provided?.slice(0, 6), ")");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let payload: EvolutionWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    console.warn("[whatsapp-webhook] reject: invalid JSON");
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  // Trace everything Evolution sends so we can see in Railway logs what
  // shape is actually coming through. Truncate the data body so logs stay readable.
  console.log("[whatsapp-webhook] event:", payload.event, "instance:", payload.instance, "hasData:", !!payload.data, "remoteJid:", payload.data?.key?.remoteJid, "fromMe:", payload.data?.key?.fromMe, "messageType:", payload.data?.messageType);

  // Event names vary across Evolution versions: "messages.upsert", "MESSAGES_UPSERT",
  // or even "messagesUpsert". Normalize before comparing.
  const evt = String(payload.event || "").toLowerCase().replace(/_/g, ".");

  // ── Group participants update (add/remove/promote/demote) ───────────────
  // Evolution forwards Baileys' group-participants.update event whenever
  // someone is added, removed, promoted ou rebaixado num grupo. Persistimos
  // como uma mensagem do tipo "groupParticipantUpdate" pra aba Conversas
  // mostrar o evento estilo WhatsApp ("Fulano foi adicionado" no centro).
  if (
    evt === "group.participants.update" ||
    evt === "groups.participants.update" ||
    evt === "group.participant.update"
  ) {
    return handleGroupParticipantsUpdate(payload, instanceNameFor(payload));
  }
  // Mudanças no grupo em si (nome, descrição, foto, settings). Não vou
  // capturar tudo por enquanto — mas reservo o evento pra futuro uso.
  if (evt === "groups.update" || evt === "group.update") {
    return NextResponse.json({ status: "ignored-for-now", event: payload.event });
  }

  if (evt !== "messages.upsert") {
    return NextResponse.json({ status: "ignored", event: payload.event });
  }

  const data = payload.data;
  const remoteJid = data?.key?.remoteJid;
  const messageId = data?.key?.id;
  const fromMe = !!data?.key?.fromMe;
  const messageType = data?.messageType || "conversation";
  const timestampSeconds = data?.messageTimestamp || Math.floor(Date.now() / 1000);
  const instanceName = payload.instance || process.env.EVOLUTION_INSTANCE || "default";

  if (!remoteJid) {
    return NextResponse.json({ error: "remoteJid ausente" }, { status: 400 });
  }

  const text = extractText(data?.message);
  const { mimetype, filename } = extractMediaInfo(data?.message, messageType);

  try {
    // Upsert by (instance, message_id, remote_jid) — Evolution can replay events
    // (e.g., after reconnect), and we want idempotency.
    const unique = {
      instance_name: instanceName,
      message_id: messageId || `noid-${Date.now()}-${Math.random()}`,
      remote_jid: remoteJid,
    };
    await prisma.whatsappMessage.upsert({
      where: { unique_message: unique },
      update: {
        // If we get a richer payload later (e.g., status update), update what we know
        text: text ?? undefined,
        push_name: data?.pushName ?? undefined,
        raw_event: payload as unknown as object,
      },
      create: {
        message_id: messageId || null,
        instance_name: instanceName,
        remote_jid: remoteJid,
        from_me: fromMe,
        push_name: data?.pushName || null,
        message_type: messageType,
        text,
        media_mimetype: mimetype,
        media_filename: filename,
        timestamp_ms: BigInt(timestampSeconds) * BigInt(1000),
        raw_event: payload as unknown as object,
      },
    });
    console.log("[whatsapp-webhook] persisted:", remoteJid, "fromMe:", fromMe, "type:", messageType);

    // Se for grupo, garante que existe um stub systemNotice com o subject real
    // (pra Conversas mostrar o nome do grupo, não o do último remetente).
    // Fire-and-forget: não bloqueia o ack do webhook.
    if (remoteJid.endsWith("@g.us")) {
      ensureGroupStub(remoteJid, instanceName).catch((err) => {
        console.warn("[whatsapp-webhook] ensureGroupStub error:", remoteJid, (err as Error).message);
      });
    }

    // Fan out to any /api/whatsapp/events subscribers so the UI updates in
    // real time. Best-effort: emit failures shouldn't fail the webhook (the
    // DB row is the source of truth — fallback polling would catch it).
    try {
      whatsappBus.emit("message", {
        type: "message",
        remote_jid: remoteJid,
        from_me: fromMe,
        message_type: messageType,
        text,
        push_name: data?.pushName || null,
        timestamp_ms: timestampSeconds * 1000,
      });
    } catch (busErr) {
      console.warn("[whatsapp-webhook] bus emit failed:", (busErr as Error).message);
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("[whatsapp-webhook] persist error:", (err as Error).message);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// Evolution may HEAD/GET the URL to verify reachability — respond OK
export async function GET() {
  return NextResponse.json({ status: "alive" });
}
