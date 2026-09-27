import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { listJobs, dismissFinishedJobs } from "@/lib/agent/jobs";

/**
 * IMPORT PROGRESS.
 *
 *   GET    /api/knowledge/jobs?tenantId=…   what is importing, and how far along
 *   DELETE /api/knowledge/jobs?tenantId=…   clear finished rows the user has read
 *
 * ── WHY POLLING RATHER THAN SSE ──────────────────────────────────────────
 * The chat endpoint streams because a reply arrives token by token and any
 * delay is felt. Import progress is different: it changes on chunk and page
 * boundaries, seconds apart. Polling once a second loses nothing perceptible
 * and avoids a long-lived connection per open dashboard tab — connections that
 * would need reaping when a laptop sleeps, a tab is backgrounded, or a proxy
 * decides they have been idle too long.
 *
 * The client also stops polling entirely once nothing is running, so an idle
 * dashboard makes no requests at all.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Reading this also REAPS abandoned jobs (see lib/agent/jobs.js): a job whose
 * process died would otherwise show a progress bar that never moves, which
 * looks far more like "still working" than like "broken".
 */
export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    const jobs = await listJobs(tenantId);
    return NextResponse.json({
      jobs,
      // Lets the client stop polling without re-deriving the condition itself.
      active: jobs.some((j) => j.status === "queued" || j.status === "processing"),
    });
  } catch (err) {
    console.error("GET /api/knowledge/jobs failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    return NextResponse.json({ cleared: await dismissFinishedJobs(tenantId) });
  } catch (err) {
    console.error("DELETE /api/knowledge/jobs failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
