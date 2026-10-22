import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant, isValidTenantId } from "@/lib/tenant/registry";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { isValidAgentId } from "@/lib/tenant/agent-request";
import { translator } from "@/lib/i18n";
import { listNumbers, addNumber } from "@/lib/standins/numbers";
import { describeNumberError } from "@/lib/telephony/errors";

/**
 * A TENANT'S PHONE NUMBERS (CLAUDE.md §6.29) — and which agent each one rings.
 *
 *   GET  /api/numbers?tenantId=…[&agentId=…][&includeReleased=1]   → { numbers }
 *   POST /api/numbers?tenantId=…   { e164, label?, agentId?, kind?: "purchased"|"forwarding" } → 201 { number }
 *
 * ⚠ Backed by a STAND-IN (src/lib/standins/numbers.js). Buying, porting, releasing and billing a
 * number is the backend's (docs/handoff-to-backend.md B11); this route is what the console uses
 * until then, and the shape the backend's dashboard needs. The ENGINE's own use of numbers is the
 * lookup — tenant/registry.js resolveDialledNumber(), and GET /api/numbers/lookup to try it.
 *
 * A number is given in international form ("+44 20 7123 4567"; a number without its country code
 * is refused, not guessed). It rings exactly one ACTIVE agent of this tenant, or none yet.
 */
export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const params = request.nextUrl.searchParams;
    const tenantId = params.get("tenantId");
    const locale = await uiLocaleFor(request, tenantId);
    const tr = translator(locale);
    if (!tenantId) return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    if (!isValidTenantId(tenantId)) return NextResponse.json({ error: tr("validation:tenantId.invalid") }, { status: 400 });

    const agentId = params.get("agentId") || undefined;
    if (agentId && !isValidAgentId(agentId)) return NextResponse.json({ error: tr("validation:agents.invalidId") }, { status: 400 });
    const includeReleased = params.get("includeReleased") === "1" || params.get("includeReleased") === "true";

    const numbers = await listNumbers(tenantId, { includeReleased, agentId });
    return NextResponse.json({ numbers, locale });
  } catch (err) {
    console.error("GET /api/numbers failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function POST(request) {
  let tr = translator("en");
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    const locale = await uiLocaleFor(request, tenantId);
    tr = translator(locale);
    if (!tenantId) return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });

    const serviceable = await requireServiceableTenant({ tenantId, tr });
    if (!serviceable.ok) return NextResponse.json({ error: serviceable.error }, { status: serviceable.status });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: tr("validation:body.invalid") }, { status: 400 });
    }

    const number = await addNumber(tenantId, { e164: body.e164, label: body.label, agentId: body.agentId ?? null, kind: body.kind });
    return NextResponse.json({ number, locale }, { status: 201 });
  } catch (err) {
    const described = describeNumberError(err, tr);
    if (described) return NextResponse.json({ error: described.error }, { status: described.status });
    console.error("POST /api/numbers failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
