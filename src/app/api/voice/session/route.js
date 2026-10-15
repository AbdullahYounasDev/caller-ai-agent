import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import { hit } from "@/lib/security/rate-limit";
import { translator, resolveLocale } from "@/lib/i18n";
import { issueTicket, ticketSecret } from "@/lib/voice/ticket";
import { LIMITS } from "@/lib/voice/config";
import { gatewayUrls } from "@/lib/voice/gateway-url";

/**
 * START A VOICE CALL — the test console's "Call" button lands here first.
 *
 *   POST /api/voice/session?tenantId=…   → { ticket, url, healthUrl, expiresAt }
 *
 * This route does the CHECKING; the gateway does the CALLING. Internal auth, the tenant
 * check (§4, §6.18) and a per-tenant rate limit all happen here, inside the Next.js app
 * where every other route does them, and the browser leaves with a one-minute,
 * single-use ticket for the gateway's WebSocket (lib/voice/ticket.js) — never with the
 * internal key itself.
 *
 * Like /api/chat this is a TEST surface, not a product channel: a real caller arrives
 * through a phone number and a verified Twilio webhook, not through this route (§9.2).
 */

/** Dialling is cheap to ask for and expensive to serve (every call loads the CPU and
 *  the model quota), so a tenant gets a handful per minute — far above what a person
 *  pressing Call ever needs. */
const TENANT_SESSION_LIMIT = { limit: 10, windowMs: 60_000 };

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


export async function POST(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tr = uiTranslator(request);
    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    }

    const serviceable = await requireServiceableTenant({ tenantId, tr });
    if (!serviceable.ok) {
      return NextResponse.json({ error: serviceable.error }, { status: serviceable.status });
    }

    const limited = hit({ key: `voice:session:${tenantId}`, ...TENANT_SESSION_LIMIT });
    if (!limited.ok) {
      return NextResponse.json(
        { error: tr("validation:voice.rateLimited"), retryAfterSec: limited.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
      );
    }

    const secret = ticketSecret();
    if (!secret) {
      return NextResponse.json({ error: "VOICE_SESSION_SECRET is not configured on the server" }, { status: 500 });
    }

    const { ticket, expiresAt } = issueTicket({ tenantId, ttlMs: LIMITS.sessionTicketTtlMs, secret });
    return NextResponse.json({ ticket, expiresAt, ...gatewayUrls(request) });
  } catch (err) {
    console.error("POST /api/voice/session failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
