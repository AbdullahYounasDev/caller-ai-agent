import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { resolveDialledNumber } from "@/lib/tenant/registry";

/**
 * TRY THE PHONE-NUMBER LOOKUP (§6.29) — what the phone webhook will do with a dialled number.
 *
 *   GET /api/numbers/lookup?to=+442071234567
 *     → 200 { ok: true, e164, tenantId, agentId, numberId }
 *     → 200 { ok: false, e164?, reason: invalid_number|unknown|released|unassigned|agent_archived|tenant_unserviceable }
 *
 * Internal-auth guarded and read-only. It takes NO tenantId on purpose: the dialled number alone
 * decides the business, exactly as it will for a real call. The backend can use it to check a
 * number is wired up before printing it anywhere; the console uses it in "call as if dialling".
 * A refusal is an answer (200), not an error — "this number rings nobody" is the information.
 */
export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const to = request.nextUrl.searchParams.get("to");
    if (!to) return NextResponse.json({ error: "to is required" }, { status: 400 });

    return NextResponse.json(await resolveDialledNumber(to, { skipCache: true }));
  } catch (err) {
    console.error("GET /api/numbers/lookup failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
