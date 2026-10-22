import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkInternalAuth } from "@/lib/auth/internal";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { translator } from "@/lib/i18n";
import { requireAgent, agentScope } from "@/lib/tenant/agent-request";

/**
 * CALL HISTORY — the most recent calls for a tenant, newest first.
 *
 *   GET /api/voice/calls?tenantId=…[&agentId=…]&limit=20
 *
 * With `agentId`, only that agent's calls; without it, every agent's. Each call says which
 * agent answered it (`agentId`).
 *
 * A summary per call (status, duration, turns, interruptions, median latency, and how
 * many of its turns the knowledge base could not answer). The full transcript, turns and
 * timeline are at /api/voice/calls/:id. Read-only and internal-auth guarded; reading a
 * tenant's own history is not gated on serviceability (§6.18).
 */
export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit")) || 20, 1), 100);

    let scope = {};
    if (request.nextUrl.searchParams.get("agentId")) {
      const tr = translator(await uiLocaleFor(request, tenantId));
      const agent = await requireAgent({ tenantId, params: request.nextUrl.searchParams, tr });
      if (!agent.ok) return NextResponse.json({ error: agent.error }, { status: agent.status });
      scope = agentScope(agent.agentId, agent.config.isDefault);
    }

    const calls = await prisma.callLog.findMany({
      where: { tenantId, ...scope },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        agentId: true,
        transport: true,
        status: true,
        endReason: true,
        turnCount: true,
        interruptions: true,
        medianResponseMs: true,
        durationSec: true,
        createdAt: true,
        endedAt: true,
      },
    });

    // "How many questions could it not answer?" per call, in one grouped query rather
    // than one per row.
    const unanswered = calls.length
      ? await prisma.callTurn.groupBy({
          by: ["callId"],
          where: { callId: { in: calls.map((c) => c.id) }, outcome: "no_knowledge" },
          _count: { _all: true },
        })
      : [];
    const unansweredByCall = new Map(unanswered.map((u) => [u.callId, u._count._all]));

    return NextResponse.json({
      calls: calls.map((c) => ({ ...c, unanswered: unansweredByCall.get(c.id) ?? 0 })),
    });
  } catch (err) {
    console.error("GET /api/voice/calls failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
