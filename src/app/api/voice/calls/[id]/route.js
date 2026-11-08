import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkInternalAuth } from "@/lib/auth/internal";

/**
 * ONE CALL, IN FULL.
 *
 *   GET /api/voice/calls/:id?tenantId=…
 *     → { call, turns, events }
 *
 * `turns` carry the per-turn intent, outcome, sources and stage timings; `events` are the
 * call's timeline in order. Scoped by tenantId as well as id — one tenant can never read
 * another's call by guessing a uuid (the same rule as lib/agent/ingest.js getSource).
 */
export async function GET(request, context) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    // In this Next.js, dynamic route params are async and must be awaited.
    const { id } = await context.params;

    const call = await prisma.callLog.findUnique({
      where: { id },
      include: {
        turns: { orderBy: { index: "asc" } },
        events: { orderBy: { seq: "asc" }, select: { seq: true, type: true, atMs: true, data: true } },
      },
    });
    if (!call || call.tenantId !== tenantId) {
      return NextResponse.json({ error: "Call not found" }, { status: 404 });
    }

    // The pointer to the audio is the storage's business; the caller of this API only needs to know there is some
    // (it is fetched from /api/voice/calls/:id/recording).
    const { turns, events, recordingUrl, ...summary } = call;
    return NextResponse.json({ call: { ...summary, hasRecording: Boolean(recordingUrl) }, turns, events });
  } catch (err) {
    console.error("GET /api/voice/calls/[id] failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
