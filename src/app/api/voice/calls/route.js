import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkInternalAuth } from "@/lib/auth/internal";

/**
 * CALL HISTORY — the most recent calls for a tenant, newest first.
 *
 *   GET /api/voice/calls?tenantId=…&limit=20
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

    const calls = await prisma.callLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
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
