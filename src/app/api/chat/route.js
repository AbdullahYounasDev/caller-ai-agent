import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkInternalAuth } from "@/lib/auth/internal";
import { respond } from "@/lib/agent/respond";

/**
 * THE TEST CHAT — how we exercise the agent while the real channel is built.
 *
 *   POST /api/chat?tenantId=…   { message, conversationId? }
 *        → SSE: session, chunk…, done | error
 *
 * ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────
 * This is an INTERNAL TESTING SURFACE, not a product channel. It exists so the
 * RAG pipeline — retrieval, grounding, the anti-hallucination guards, the reply
 * language — can be exercised by a human typing questions, which is far faster
 * than waiting on a phone call to prove a prompt change worked.
 *
 * It is internal-auth guarded and takes `tenantId` as a query parameter,
 * because the caller is us. **It must never be exposed to the public.** The
 * embeddable widget that used to live here — public keys, origin allowlists,
 * signed conversation tokens, CORS — has been removed along with the rest of
 * the widget. When the real public channel arrives it will be TELEPHONY, and
 * its caller identity comes from the provider's webhook (a verified Twilio
 * signature and a dialed number), not from anything a browser sends.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Streaming is kept even though a test harness could live without it: voice
 * will need token-by-token output to start speaking before the sentence is
 * finished, so the path stays exercised rather than being rebuilt later.
 */
export async function POST(request) {
  const auth = checkInternalAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const tenantId = request.nextUrl.searchParams.get("tenantId");
  if (!tenantId) {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const message = String(body?.message ?? "");
  if (!message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // Continue an existing conversation, or start one. Scoped by tenant so a
  // stray id from another business is treated as a new conversation rather
  // than joined.
  let conversationId = body?.conversationId ?? null;
  if (conversationId) {
    const existing = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { tenantId: true },
    });
    if (!existing || existing.tenantId !== tenantId) conversationId = null;
  }
  if (!conversationId) {
    const created = await prisma.conversation.create({
      data: { tenantId, channel: "chat" },
    });
    conversationId = created.id;
  }

  const encoder = new TextEncoder();
  const send = (controller, event, data) =>
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      try {
        // Sent first so the client can keep the conversation even if generation
        // then fails — otherwise a failed first message orphans it.
        send(controller, "session", { conversationId });

        const { reply, model, sources } = await respond({
          tenantId,
          conversationId,
          channel: "chat",
          userMessage: message,
          onChunk: (text) => {
            if (closed) return;
            try {
              send(controller, "chunk", { text });
            } catch {
              closed = true;
            }
          },
        });

        // DEBUG METADATA for the test console — which model answered and
        // which of the tenant's documents (if any) it was grounded in. Never
        // part of `reply` itself, so it stays out of anything that might one
        // day read the reply aloud.
        if (!closed) send(controller, "done", { reply, model, sources });
      } catch (err) {
        console.error("POST /api/chat failed:", err);
        if (!closed) {
          try {
            send(controller, "error", { message: String(err?.message ?? err).slice(0, 300) });
          } catch {
            // Client already gone.
          }
        }
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx buffers proxied responses by default, which holds the whole
      // stream until it completes and silently undoes streaming entirely.
      "X-Accel-Buffering": "no",
    },
  });
}
