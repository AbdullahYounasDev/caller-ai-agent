import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { cancelJob } from "@/lib/agent/jobs";

/**
 * CANCEL ONE RUNNING (OR QUEUED) IMPORT.
 *
 *   DELETE /api/knowledge/jobs/:id?tenantId=…
 *
 * A queued job is simply removed before it starts. A processing job can't be
 * stopped mid-await, so cancelJob() marks it and the job's own next progress
 * checkpoint (once per page/chunk) notices and unwinds — see lib/agent/jobs.js.
 * Whatever partial document, chunks or Cloudinary upload that job had produced
 * by then is rolled back or removed as part of that unwind, in lib/agent/ingest.js.
 */

async function routeId(context) {
  const params = await context.params;
  return params.id;
}

export async function DELETE(request, context) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    const job = await cancelJob(tenantId, await routeId(context));
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json({ job });
  } catch (err) {
    console.error("DELETE /api/knowledge/jobs/[id] failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
