import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { whatsappBus, type WhatsappEvent } from "@/lib/services/whatsapp-bus";

// Server-Sent Events stream for live WhatsApp updates.
//
// The /conversas page opens this as an EventSource. Whenever the webhook
// persists a new message it emits on whatsappBus, and we forward the event
// here as `data: {json}\n\n`. The browser updates without polling.
//
// Notes:
//  - runtime must be "nodejs" — Edge can't keep long-lived connections to a
//    Node EventEmitter and would also re-instantiate the bus per request.
//  - dynamic = "force-dynamic" tells Next not to cache or pre-render.
//  - We send a comment line (`: keepalive`) every 25s. Railway / reverse
//    proxies often drop idle connections after ~30-60s; the comment keeps
//    the socket warm without polluting the data stream.
//  - request.signal fires when the browser disconnects (tab close, nav,
//    network drop). We MUST detach the listener there or the bus would leak
//    a subscriber per disconnect.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Stream already closed by the runtime — mark and bail.
          closed = true;
        }
      };

      // Initial hello so the client knows the connection is live. EventSource
      // doesn't fire `onopen` for HTTP-level "open" reliably across browsers
      // until the first chunk arrives, so we always push one.
      safeEnqueue(encoder.encode(`event: hello\ndata: {"ok":true}\n\n`));

      const onMessage = (event: WhatsappEvent) => {
        const payload = JSON.stringify(event);
        safeEnqueue(encoder.encode(`event: message\ndata: ${payload}\n\n`));
      };
      whatsappBus.on("message", onMessage);

      // Keep proxies from killing the idle socket. Lines starting with `:`
      // are SSE comments — clients ignore them but the bytes count as
      // activity for any intermediate timeout.
      const keepalive = setInterval(() => {
        safeEnqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      }, 25000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        whatsappBus.off("message", onMessage);
        clearInterval(keepalive);
        try { controller.close(); } catch { /* already closed */ }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable nginx buffering — Railway's edge proxy honors this.
      "X-Accel-Buffering": "no",
    },
  });
}
