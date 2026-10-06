import {
  addSseClient,
  formatSseEvent,
  removeSseClient,
} from "@/lib/sse";
import { denyUnlessRoutePermission } from "@/lib/route-permission.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

export async function GET(request) {
  const denied = await denyUnlessRoutePermission("plate.read");
  if (denied) return denied;

  let clientId = null;
  let heartbeat = null;
  let closed = false;
  let streamController = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    request.signal.removeEventListener("abort", close);
    if (clientId !== null) removeSseClient(clientId);
  };

  const close = () => {
    if (closed) return;
    cleanup();
    try { streamController?.close(); } catch { /* The response may already be canceled. */ }
  };

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      const send = (payload) => {
        if (closed) return;
        controller.enqueue(encoder.encode(payload));
      };
      clientId = addSseClient(send, close);
      if (closed) return;
      send("retry: 3000\n\n");
      send(formatSseEvent("heartbeat", { connected: true }));
      heartbeat = setInterval(() => {
        try {
          send(formatSseEvent("heartbeat", { timestamp: Date.now() }));
        } catch {
          close();
        }
      }, 25_000);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
