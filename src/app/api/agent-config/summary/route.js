import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import { requireAgent } from "@/lib/tenant/agent-request";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { hit } from "@/lib/security/rate-limit";
import { translator } from "@/lib/i18n";
import { draftSummary } from "@/lib/agent/profile-summary";
import { SUMMARY_MAX_DOCUMENTS } from "@/lib/agent/summary-rules";

/**
 * WRITE A DRAFT BUSINESS SUMMARY from documents the owner chose (CLAUDE.md §6.20).
 *
 *   POST /api/agent-config/summary?tenantId=…[&agentId=…]
 *   body { "sourceIds": ["…", …], "language": "en" | "ur" }
 *   → { draft, sources: [{id, title}], skipped: [{id, title, reason}], removed: ["sentence with a price", …] }
 *
 * Saves NOTHING: the owner reads the draft, edits it, and saves it with PUT /api/agent-config
 * ({ profileSummary, profileSummarySourceIds }). Only documents this agent may use are read (§6.28);
 * the others come back in `skipped` with the reason. Costs one model call, so a tenant gets a few a
 * minute — far more than a person clicking the button needs.
 */

const TENANT_LIMIT = { limit: 6, windowMs: 60_000 };

export async function POST(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    const locale = await uiLocaleFor(request, tenantId);
    const tr = translator(locale);
    if (!tenantId) return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });

    const serviceable = await requireServiceableTenant({ tenantId, tr });
    if (!serviceable.ok) return NextResponse.json({ error: serviceable.error }, { status: serviceable.status });

    const agent = await requireAgent({ tenantId, params: request.nextUrl.searchParams, tr });
    if (!agent.ok) return NextResponse.json({ error: agent.error }, { status: agent.status });

    const body = await request.json().catch(() => null);
    const ids = body?.sourceIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > SUMMARY_MAX_DOCUMENTS || ids.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: tr("validation:summary.sourcesInvalid", { vars: { max: SUMMARY_MAX_DOCUMENTS } }) }, { status: 400 });
    }

    const limited = hit({ key: `summary:${tenantId}`, ...TENANT_LIMIT });
    if (!limited.ok) {
      return NextResponse.json(
        { error: tr("validation:summary.rateLimited"), retryAfterSec: limited.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
      );
    }

    const result = await draftSummary({
      tenantId,
      agentId: agent.agentId,
      businessName: agent.config.businessName,
      sourceIds: ids,
      language: body?.language === "ur" ? "ur" : body?.language === "en" ? "en" : locale === "ur" ? "ur" : "en",
    });
    if (!result.sources.length) return NextResponse.json({ error: tr("validation:summary.nothingUsable"), skipped: result.skipped }, { status: 409 });
    return NextResponse.json(result);
  } catch (err) {
    // A model failure is shown through the console's humanizeError (quota, outage — §6.16).
    console.error("POST /api/agent-config/summary failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 502 });
  }
}
