import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAgentConfig } from "@/lib/tenant/config";
import {
  resolveTenantByPublicKey,
  assertTenantServiceable,
  touchWidgetKey,
} from "@/lib/tenant/registry";
import { checkOrigin, corsHeaders } from "@/lib/security/origin";
import { hit, WIDGET_LIMITS } from "@/lib/security/rate-limit";
import { signConversation, verifyConversation } from "@/lib/security/session";
import { t, resolveLocale, DEFAULT_LOCALE } from "@/lib/i18n";
import { respond } from "@/lib/agent/respond";

/**
 * PUBLIC ENDPOINT. Reachable from any website on the internet, because that is
 * the entire point of an embeddable widget.
 *
 * Request:  { publicKey, message, conversationId?, conversationToken?, locale? }
 * Response: { conversationId, conversationToken, reply, locale }
 *
 * THE GUARD CHAIN, in order, and the order matters — each step is cheaper than
 * the one after it, so abuse is rejected before it costs anything:
 *   1. resolve the key            → which tenant is this?      (cached)
 *   2. origin allowlist           → is this site allowed?      (no I/O)
 *   3. rate limit per key         → is this key being hammered?(no I/O)
 *   4. tenant serviceable         → active / in-quota?         (the tenant_core seam)
 *   5. conversation ownership     → is this thread theirs?     (one indexed read)
 *   6. rate limit per conversation→ is this one visitor looping?
 *   7. …only now do we spend money on embeddings + generation
 *
 * `tenantId` is NEVER accepted from the request body. That was the hole: any
 * caller could name any tenant and read or write their conversations.
 *
 * EVERY error message here is translated. These strings are shown to a real
 * customer inside a business's chat widget — an English "Too many requests" in
 * an otherwise Arabic interface is the business's embarrassment, not ours.
 */

export async function OPTIONS(request) {
  // Preflight. The browser sends this before the real POST on any cross-origin
  // request with a JSON content type. A preflight has no body, so the key comes
  // from the query string here — the widget appends `?key=` to its POST URL for
  // exactly this reason.
  const publicKey = request.nextUrl.searchParams.get("key");
  const tenant = publicKey ? await resolveTenantByPublicKey(publicKey) : null;

  // Unknown key at preflight time: answer without CORS headers. The browser
  // then blocks the request, which is the correct outcome and leaks nothing
  // about whether the key exists.
  if (!tenant) return new NextResponse(null, { status: 204 });

  const origin = checkOrigin(request, tenant.allowedOrigins);
  if (!origin.ok) return new NextResponse(null, { status: 204 });

  return new NextResponse(null, { status: 204, headers: corsHeaders(origin.origin) });
}

export async function POST(request) {
  let cors = {};
  // Best guess until the tenant is known: the browser's own preference. Errors
  // raised BEFORE we can look up the tenant's languages still have to be
  // readable, and a visitor's Accept-Language is the only signal available.
  let locale = resolveLocale({
    acceptLanguage: request.headers.get("accept-language"),
    enabled: undefined,
    fallback: DEFAULT_LOCALE,
  });

  /** Translated error response, with whatever CORS headers we've established. */
  const fail = (key, status, extraHeaders = {}) =>
    NextResponse.json(
      { error: t({ locale, key: `errors:${key}` }) },
      { status, headers: { ...cors, ...extraHeaders } }
    );

  try {
    const body = await request.json().catch(() => null);
    const {
      publicKey,
      message,
      conversationId: incomingConversationId,
      conversationToken,
      locale: requestedLocale,
    } = body ?? {};

    // --- 1. Who is this? ---------------------------------------------------
    const tenant = await resolveTenantByPublicKey(publicKey);
    if (!tenant) {
      // One response for unknown / revoked / malformed alike: distinguishing
      // them turns this endpoint into an oracle for probing valid keys.
      return fail("invalidKey", 401);
    }

    // --- 2. Is this site allowed to use it? --------------------------------
    // Every response from here on is cross-origin readable, INCLUDING the
    // rejection — otherwise the widget shows "network error" for what is really
    // "your domain isn't allowlisted", and a business can't diagnose its own
    // install. The rejection still rejects; see checkOrigin's note.
    const origin = checkOrigin(request, tenant.allowedOrigins);
    cors = corsHeaders(origin.origin);
    if (!origin.ok) return fail("originNotAllowed", origin.status);

    // --- 3. Is this key being hammered? ------------------------------------
    const keyLimit = hit({ key: `widget:${publicKey}`, ...WIDGET_LIMITS.perKey });
    if (!keyLimit.ok) {
      return fail("tooManyRequests", 429, { "Retry-After": String(keyLimit.retryAfterSec) });
    }

    // --- 4. Is this tenant serviceable? ------------------------------------
    // The tenant_core seam. Today always ok; later: suspended, unpaid, quota.
    const serviceable = await assertTenantServiceable(tenant.tenantId);
    if (!serviceable.ok) {
      return fail(serviceable.status === 429 ? "quotaExceeded" : "accountSuspended", serviceable.status);
    }

    // Now that the tenant is known, narrow the locale to what this business
    // actually supports — a visitor whose browser asks for Urdu shouldn't get
    // an Urdu error from a business that only operates in English and Italian.
    const config = await getAgentConfig(tenant.tenantId);
    locale = resolveLocale({
      requested: requestedLocale,
      acceptLanguage: request.headers.get("accept-language"),
      enabled: config.languages,
      fallback: config.defaultLocale,
    });

    if (typeof message !== "string" || !message.trim()) {
      return fail("messageRequired", 400);
    }
    if (message.length > 4000) {
      // Bounded before it reaches an embedding call — an unbounded message is a
      // direct line from a stranger to a tenant's token bill.
      return fail("messageTooLong", 400);
    }

    // --- 5. Whose conversation is this? ------------------------------------
    let conversationId = incomingConversationId;
    let issuedToken;

    if (conversationId) {
      // Possession of the id is not enough — the signed token proves this
      // client is the one we handed the conversation to.
      if (!verifyConversation(conversationId, conversationToken)) {
        return fail("invalidSession", 401);
      }

      const existing = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { tenantId: true },
      });

      // A valid token for a conversation belonging to ANOTHER tenant must not
      // work through this key. Same error as a bad token — a different message
      // here would confirm that the conversation exists.
      if (!existing || existing.tenantId !== tenant.tenantId) {
        return fail("invalidSession", 401);
      }

      issuedToken = conversationToken;
    } else {
      const conversation = await prisma.conversation.create({
        data: { tenantId: tenant.tenantId, channel: "widget", locale },
      });
      conversationId = conversation.id;
      issuedToken = signConversation(conversationId);
    }

    // --- 6. Is this one visitor looping? -----------------------------------
    // Tighter than the per-key limit: no human types 20 messages a minute, and
    // scoping it per conversation means one abusive visitor can't lock out a
    // busy site's other customers.
    const convLimit = hit({
      key: `conv:${conversationId}`,
      ...WIDGET_LIMITS.perConversation,
    });
    if (!convLimit.ok) {
      return fail("rateLimited", 429, { "Retry-After": String(convLimit.retryAfterSec) });
    }

    // --- 7. Everything checks out: do the expensive part -------------------
    touchWidgetKey(tenant.keyId); // fire-and-forget, throttled

    const { reply, locale: replyLocale } = await respond({
      tenantId: tenant.tenantId,
      conversationId,
      channel: "widget",
      userMessage: message,
      locale,
    });

    return NextResponse.json(
      { conversationId, conversationToken: issuedToken, reply, locale: replyLocale },
      { headers: cors }
    );
  } catch (err) {
    // Without this, an exception (DB not migrated, bad GEMINI_API_KEY, DB down)
    // kills the response before any body is sent — the client sees an empty
    // response and "Unexpected end of JSON input" instead of the real cause.
    // The real error goes to the server log; the customer gets a sentence they
    // can read, in their own language.
    console.error("POST /api/widget failed:", err);
    return fail("generic", 500);
  }
}
