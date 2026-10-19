import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { translator } from "@/lib/i18n";
import { getRecord, updateRecordStatus } from "@/lib/standins/records";

/**
 * ONE REQUEST — read it, or move it along.
 *
 *   GET   /api/records/:id?tenantId=…
 *   PATCH /api/records/:id?tenantId=…   body { status: "confirmed" | "done" | "cancelled" | "requested" }
 *
 * The agent never calls this: it can only CREATE a request, as "requested". Confirming is a
 * person's decision (CLAUDE.md §6.11), which is why moving a status is a separate, guarded
 * route and why an id that belongs to another tenant answers 404, not 403 — it must not
 * confirm that the id exists.
 */

async function context(request) {
  const auth = checkInternalAuth(request);
  if (!auth.ok) return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  const tenantId = request.nextUrl.searchParams.get("tenantId");
  const tr = translator(await uiLocaleFor(request, tenantId));
  if (!tenantId) return { response: NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 }) };
  return { tenantId, tr };
}

export async function GET(request, { params }) {
  try {
    const ctx = await context(request);
    if (ctx.response) return ctx.response;
    const { id } = await params;
    const record = await getRecord(ctx.tenantId, id);
    if (!record) return NextResponse.json({ error: ctx.tr("validation:records.notFound") }, { status: 404 });
    return NextResponse.json({ record });
  } catch (err) {
    console.error("GET /api/records/:id failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const ctx = await context(request);
    if (ctx.response) return ctx.response;
    const { tenantId, tr } = ctx;

    const serviceable = await requireServiceableTenant({ tenantId, tr });
    if (!serviceable.ok) return NextResponse.json({ error: serviceable.error }, { status: serviceable.status });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.status !== "string") {
      return NextResponse.json({ error: tr("validation:body.invalid") }, { status: 400 });
    }

    const { id } = await params;
    const result = await updateRecordStatus(tenantId, id, body.status);
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : result.reason === "invalid_transition" ? 409 : 400;
      const key = { not_found: "notFound", invalid_status: "invalidStatus", invalid_transition: "invalidTransition" }[result.reason];
      return NextResponse.json({ error: tr(`validation:records.${key}`) }, { status });
    }
    return NextResponse.json({ record: result.record });
  } catch (err) {
    console.error("PATCH /api/records/:id failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}
