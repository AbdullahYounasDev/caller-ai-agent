import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkInternalAuth } from "@/lib/auth/internal";
import { respond } from "@/lib/agent/respond";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import { hit } from "@/lib/security/rate-limit";
import { translator, resolveLocale } from "@/lib/i18n";

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

/** Generous for even a verbose typed question — a customer chatting is not
 *  pasting a document. Bounds the embedding + generation cost of one message
 *  and closes off "message" as a way to smuggle a large document in outside
 *  the normal knowledge-upload path (which has its own limits — see
 *  extract.js's MAX_UPLOAD_BYTES). */
const MAX_MESSAGE_CHARS = 4000;

/**
 * TWO-LAYER RATE LIMIT — the shape lib/security/rate-limit.js's own header
 * comment describes, wired up here as its first real caller.
 *
 *   TENANT (loose):       catches "this account's traffic has gone wrong"
 *     without punishing a business that legitimately has several
 *     conversations running at once. 60/min is ~1 request/sec sustained —
 *     comfortably above what a handful of real, simultaneous conversations
 *     would ever produce, comfortably below what an unthrottled script could.
 *   CONVERSATION (tight):  no real person reads a reply and types a follow-up
 *     in well under two seconds, so this is the layer that actually catches
 *     one caller (or one script) looping on a single conversation.
 *
 * Every message already costs an embedding call plus a generation call
 * against a shared, scarce quota (CLAUDE.md §8 limitation 3) — both layers
 * exist to protect that quota from a runaway loop, not to shape legitimate
 * use. Starting points, not yet measured against real traffic — re-tune once
 * they have been, per rate-limit.js.
 */
const TENANT_LIMIT = { limit: 60, windowMs: 60_000 };
const CONVERSATION_LIMIT = { limit: 5, windowMs: 10_000 };

function uiTranslator(request) {
  return translator(
    resolveLocale({
      requested: request.nextUrl.searchParams.get("locale"),
      acceptLanguage: request.headers.get("accept-language"),
      enabled: undefined,
      fallback: undefined,
    })
  );
}

/** `Retry-After` is seconds, per HTTP spec — `hit()` already computes exactly
 *  that, so no conversion happens at the call site. */
function rateLimited(tr, retryAfterSec) {
  return NextResponse.json(
    { error: tr("validation:chat.rateLimited"), retryAfterSec },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );
}

export async function POST(request) {
  const auth = checkInternalAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const tr = uiTranslator(request);
  const tenantId = request.nextUrl.searchParams.get("tenantId");
  if (!tenantId) {
    return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
  }

  // §4: "never let tenant-state checks leak into route handlers" — this is
  // the one shared call every mutating/serving route makes instead of each
  // growing its own suspended/quota logic. Also where tenantId's SHAPE is
  // enforced (registry.js) — it flows into a Cloudinary folder path by string
  // interpolation (storage.js) and must never carry `/` or `..`.
  const serviceable = await requireServiceableTenant({ tenantId, tr });
  if (!serviceable.ok) {
    return NextResponse.json({ error: serviceable.error }, { status: serviceable.status });
  }

  const body = await request.json().catch(() => null);
  const message = String(body?.message ?? "");
  if (!message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: tr("validation:chat.messageTooLong", { vars: { max: MAX_MESSAGE_CHARS } }) },
      { status: 400 }
    );
  }

  // TENANT-LEVEL LIMIT checked first and before any DB work — the cheapest
  // possible rejection for a tenant whose traffic has already gone wrong.
  const tenantHit = hit({ key: `chat:tenant:${tenantId}`, ...TENANT_LIMIT });
  if (!tenantHit.ok) return rateLimited(tr, tenantHit.retryAfterSec);

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

  // CONVERSATION-LEVEL LIMIT — only knowable once conversationId is resolved
  // (existing or freshly created). This is the layer that actually does the
  // useful work, per rate-limit.js: catching one caller or script looping.
  const conversationHit = hit({ key: `chat:conv:${conversationId}`, ...CONVERSATION_LIMIT });
  if (!conversationHit.ok) return rateLimited(tr, conversationHit.retryAfterSec);

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

        const { reply, model, sources, searchQuery, rewriteStatus, collection } = await respond({
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
        if (!closed) send(controller, "done", { reply, model, sources, searchQuery, rewriteStatus, collection });
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
