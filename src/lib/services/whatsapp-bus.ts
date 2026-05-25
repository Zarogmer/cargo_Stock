/**
 * Process-local pub/sub for WhatsApp events.
 *
 * The webhook (/api/whatsapp/webhook) publishes here after persisting a
 * message; the SSE endpoint (/api/whatsapp/events) subscribes and pushes the
 * event down to every connected browser tab. This avoids polling: as soon as
 * Evolution delivers the message, the client UI updates.
 *
 * IMPORTANT: this is in-process only. If we ever scale to multiple Node
 * replicas on Railway, an SSE client connected to replica A won't see events
 * published on replica B. The fix at that point is a Redis pub/sub bridge —
 * everything else here stays the same.
 *
 * We pin the emitter to globalThis so it survives Next.js HMR (each module
 * reload would otherwise create a fresh emitter, breaking subscribers from
 * the previous reload).
 */
import { EventEmitter } from "events";

type Globals = typeof globalThis & {
  __whatsappBus?: EventEmitter;
};

const g = globalThis as Globals;

if (!g.__whatsappBus) {
  const bus = new EventEmitter();
  // Each open browser tab on /conversas adds one listener. Default cap is 10
  // and Node warns past that — raise to a comfortable ceiling.
  bus.setMaxListeners(500);
  g.__whatsappBus = bus;
}

export interface WhatsappEvent {
  type: "message";
  remote_jid: string;
  from_me: boolean;
  message_type: string;
  text: string | null;
  push_name: string | null;
  // Epoch ms — useful for ordering/dedup on the client.
  timestamp_ms: number;
}

export const whatsappBus: EventEmitter = g.__whatsappBus;
