import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant, isValidTenantId } from "@/lib/tenant/registry";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { listAgents, createAgent } from "@/lib/tenant/config";
import { describeAgentError, isValidAgentId } from "@/lib/tenant/agent-request";
import { translator } from "@/lib/i18n";

/**
 * A TENANT'S AGENTS (CLAUDE.md §6.27) — the list the dashboard's agent picker shows.
 *
 *   GET  /api/agents?tenantId=…[&includeArchived=1]
 *        → { agents: [{ id, name, businessName, status, isDefault, replyLanguage, createdAt, updatedAt }] }
 *          the default agent first. Never empty: a tenant that has saved nothing yet is listed
 *          with its default agent as `id: null` (nothing is written by a read); omit agentId
 *          to address it, and its first save gives it an id.
 *   POST /api/agents?tenantId=…   { name, copyFrom? }  → 201 { agent }
 *          A new agent starts as a COPY of another agent's settings (`copyFrom`, default: the
 *          default agent) — a new branch or line almost always shares the business name, hours,
 *          voice and the people calls go to. Edit it afterwards through
 *          /api/agent-config?agentId= and /api/collect?agentId=.
 *
 * One agent is changed through /api/agents/:id. The KNOWLEDGE library is shared by every agent
 * of a tenant (choosing documents per agent is the next step, not built yet).
 *
 * Server-to-server (x-internal-key), like every route. POST mutates, so it goes through
 * requireServiceableTenant; GET does not (§6.18).
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

    const includeArchived = params.get("includeArchived") === "1" || params.get("includeArchived") === "true";
    const agents = await listAgents(tenantId, { includeArchived });
    return NextResponse.json({ agents, locale });
  } catch (err) {
    console.error("GET /api/agents failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
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
    if (body.copyFrom != null && !isValidAgentId(body.copyFrom)) {
      return NextResponse.json({ error: tr("validation:agents.invalidId") }, { status: 400 });
    }

    const agent = await createAgent(tenantId, { name: body.name, copyFrom: body.copyFrom ?? null });
    return NextResponse.json({ agent, locale }, { status: 201 });
  } catch (err) {
    const described = describeAgentError(err, tr);
    if (described) return NextResponse.json({ error: described.error }, { status: described.status });
    console.error("POST /api/agents failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}
