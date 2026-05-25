import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { whatsappBus } from "@/lib/services/whatsapp-bus";

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
