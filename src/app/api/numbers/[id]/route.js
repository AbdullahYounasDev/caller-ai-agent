import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { translator } from "@/lib/i18n";
import { updateNumber, releaseNumber } from "@/lib/standins/numbers";
import { describeNumberError } from "@/lib/telephony/errors";

/**
 * ONE PHONE NUMBER (§6.29) — link it to another agent, rename it, or release it.
 *
 *   PATCH /api/numbers/:id?tenantId=…   { agentId?: string|null, label?, status?: "released" } → { number }
 *
 * Re-linking takes effect for the NEXT caller (the cached route is dropped); a call already in
 * progress keeps the agent it was answered by. Releasing stops the number routing at once; the row
 * stays so its call history still says which line a call came in on, and the number can be added
 * again later. There is no DELETE for the same reason. ⚠ Stand-in for the backend (B11).
 */
export async function PATCH(request, context) {
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

    // In this Next.js, dynamic route params are async and must be awaited.
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: tr("validation:body.invalid") }, { status: 400 });
    }
    if (body.status !== undefined && body.status !== "released") {
      return NextResponse.json({ error: tr("validation:numbers.statusInvalid") }, { status: 400 });
    }

    const number =
      body.status === "released"
        ? await releaseNumber(tenantId, id)
        : await updateNumber(tenantId, id, { agentId: body.agentId, label: body.label });
    return NextResponse.json({ number, locale });
  } catch (err) {
    const described = describeNumberError(err, tr);
    if (described) return NextResponse.json({ error: described.error }, { status: described.status });
    console.error("PATCH /api/numbers/[id] failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
