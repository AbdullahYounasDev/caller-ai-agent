import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant, resolveDialledNumber } from "@/lib/tenant/registry";
import { describeRouteRefusal } from "@/lib/telephony/errors";
import { requireAgent } from "@/lib/tenant/agent-request";
import { hit } from "@/lib/security/rate-limit";
import { translator, resolveLocale } from "@/lib/i18n";
import { issueTicket, ticketSecret } from "@/lib/voice/ticket";
import { LIMITS } from "@/lib/voice/config";
import { gatewayUrls } from "@/lib/voice/gateway-url";

/**
 * START A VOICE CALL — the test console's "Call" button lands here first.
 *
 *   POST /api/voice/session?tenantId=…[&agentId=…]   → { ticket, agentId, url, healthUrl, expiresAt }
 *
 * `agentId` picks which agent answers (default agent if omitted); it is signed into the ticket.
 *
 *   POST /api/voice/session?tenantId=…&to=+442071234567   → the same, "as if dialling" that number
 *
 * `to` runs the REAL phone-number lookup (registry.js resolveDialledNumber, §6.29): the number —
 * not `agentId` — decides the agent, exactly as a phone call will, and the call is recorded as
 * having come in on that number. A number that rings no agent is refused with the reason (a real
 * caller would hear "not in service"). Only this tenant's numbers: another business's number is
 * "unknown" here, never connected.
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

    // Who answers: the dialled number when one is given (the phone path), else the named agent.
    let line = null;
    let agent;
    const to = request.nextUrl.searchParams.get("to");
    if (to) {
      const route = await resolveDialledNumber(to, { skipCache: true });
      if (!route.ok || route.tenantId !== tenantId) {
        // Another business's number is "unknown" here: this route never reveals that it exists.
        const reason = route.tenantId && route.tenantId !== tenantId ? "unknown" : route.reason;
        return NextResponse.json({ error: describeRouteRefusal(reason, tr), reason }, { status: 409 });
      }
      line = { numberId: route.numberId, toNumber: route.e164 };
      agent = { ok: true, agentId: route.agentId };
    } else {
      agent = await requireAgent({ tenantId, params: request.nextUrl.searchParams, tr, serving: true });
      if (!agent.ok) return NextResponse.json({ error: agent.error }, { status: agent.status });
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

    const { ticket, expiresAt } = issueTicket({ tenantId, agentId: agent.agentId, line, ttlMs: LIMITS.sessionTicketTtlMs, secret });
    return NextResponse.json({ ticket, agentId: agent.agentId, line, expiresAt, ...gatewayUrls(request) });
  } catch (err) {
    console.error("POST /api/voice/session failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
