import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { updateAgent } from "@/lib/tenant/config";
import { describeAgentError, isValidAgentId } from "@/lib/tenant/agent-request";
import { translator } from "@/lib/i18n";

/**
 * ONE AGENT (CLAUDE.md §6.27) — rename it, archive or restore it, or make it the default.
 *
 *   PATCH /api/agents/:id?tenantId=…   { name?, status?: "active"|"archived", makeDefault?: true }
 *         → { agent }
 *
 * There is no DELETE: calls, conversations and requests point at an agent, so it is ARCHIVED
 * (it stops answering; its history stays). The default agent cannot be archived — make another
 * agent the default first — because something must always answer a request that names no agent.
 * The agent's SETTINGS are edited through /api/agent-config?agentId= and /api/collect?agentId=.
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
    if (!isValidAgentId(id)) return NextResponse.json({ error: tr("validation:agents.invalidId") }, { status: 400 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: tr("validation:body.invalid") }, { status: 400 });
    }
    if (body.makeDefault !== undefined && typeof body.makeDefault !== "boolean") {
      return NextResponse.json({ error: tr("validation:body.invalid") }, { status: 400 });
    }

    const agent = await updateAgent(tenantId, id, { name: body.name, status: body.status, makeDefault: body.makeDefault === true });
    return NextResponse.json({ agent, locale });
  } catch (err) {
    const described = describeAgentError(err, tr);
    if (described) return NextResponse.json({ error: described.error }, { status: described.status });
    console.error("PATCH /api/agents/[id] failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}
