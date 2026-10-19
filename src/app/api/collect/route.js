import { NextResponse } from "next/server";
import { getAgentConfig, saveCollectConfig } from "@/lib/tenant/config";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { translator } from "@/lib/i18n";
import { pick, getField, getRecordType } from "@/lib/collect/catalog";
import { describeCatalog, validateCollectConfig } from "@/lib/collect/config";

/**
 * WHAT THE AGENT COLLECTS — the settings behind the console's "What your agent collects"
 * tab, and the contract with the partner's dashboard for the same screen.
 *
 *   GET  /api/collect?tenantId=…   the tenant's settings, plus the catalogue to draw them
 *                                  from (every field, request type and industry preset,
 *                                  each with its English and Urdu wording)
 *   PUT  /api/collect?tenantId=…   body { collect: {...} } — replace the settings
 *
 * The whole document is replaced on every save (not patched): it is one coherent set of
 * choices — which details, for which kinds of request, in which order — and a half-merged
 * one is how an appointment form ends up with no way to reach the customer. Validation
 * (lib/collect/config.js) refuses anything that would, and every refusal comes back in the
 * reader's language. Both accept `&locale=` like /api/agent-config.
 *
 * Server-to-server (x-internal-key). Mutating, so it goes through requireServiceableTenant.
 */

export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    const locale = await uiLocaleFor(request, tenantId);
    const tr = translator(locale);
    if (!tenantId) return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });

    // skipCache: the screen must never show an owner a stale copy of what it is about to edit.
    const config = await getAgentConfig(tenantId, { skipCache: true });
    return NextResponse.json({ collect: config.collect, version: config.collectVersion, catalog: describeCatalog(), locale });
  } catch (err) {
    console.error("GET /api/collect failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    const locale = await uiLocaleFor(request, tenantId);
    const tr = translator(locale);
    if (!tenantId) return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });

    const serviceable = await requireServiceableTenant({ tenantId, tr });
    if (!serviceable.ok) return NextResponse.json({ error: serviceable.error }, { status: serviceable.status });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.collect !== "object" || body.collect === null) {
      return NextResponse.json({ error: tr("validation:body.invalid") }, { status: 400 });
    }

    const { ok, config, problems } = validateCollectConfig(body.collect);
    if (!ok) {
      return NextResponse.json({ error: tr("common:state.error"), details: problems.map((p) => describeProblem(p, tr, locale)), locale }, { status: 400 });
    }

    const saved = await saveCollectConfig(tenantId, config);
    return NextResponse.json({ collect: saved.collect, version: saved.collectVersion, locale });
  } catch (err) {
    console.error("PUT /api/collect failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}

/** A validation problem as a sentence the owner can act on, naming things by their labels. */
function describeProblem(problem, tr, locale) {
  const vars = { ...problem.vars };
  if (vars.type && getRecordType(vars.type)) vars.type = pick(getRecordType(vars.type).label, locale);
  if (vars.field && getField(vars.field)) vars.field = pick(getField(vars.field).label, locale);
  if (typeof vars.fields === "string") {
    vars.fields = vars.fields.split(", ").map((id) => (getField(id) ? pick(getField(id).label, locale) : id)).join(", ");
  }
  if (vars.id && getField(vars.id)) vars.id = pick(getField(vars.id).label, locale);
  if (vars.list === "services") vars.list = tr("dashboard:collect.services.title");
  if (vars.list === "staff") vars.list = tr("dashboard:collect.staff.title");
  return tr(`validation:collect.${problem.code}`, { vars });
}
