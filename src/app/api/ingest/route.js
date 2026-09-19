import { NextResponse } from "next/server";
import { ingestDocument } from "@/lib/agent/ingest";
import { checkInternalAuth } from "@/lib/auth/internal";

// Adds a document to a tenant's knowledge base.
//
// INTERNAL ONLY. Whatever goes in here is what the agent will tell that
// business's customers is true — an unauthenticated ingest endpoint is a way to
// put words in a real company's mouth. Guarded by INTERNAL_API_KEY like the
// other server-to-server routes.
//
// Still missing (Phase 5, knowledge management): file upload (PDF/DOCX), URL
// crawl, listing and delete-by-source, and job status for large documents.
// Today re-ingesting the same source DUPLICATES its chunks rather than
// replacing them, which degrades retrieval.
export async function POST(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await request.json().catch(() => null);
    const { tenantId, source, text } = body ?? {};

    if (!tenantId || !source || !text) {
      return NextResponse.json(
        { error: "tenantId, source, and text are required" },
        { status: 400 }
      );
    }

    const result = await ingestDocument({ tenantId, source, text });
    return NextResponse.json(result);
  } catch (err) {
    console.error("POST /api/ingest failed:", err);
    return NextResponse.json(
      { error: err.message || "Something went wrong" },
      { status: 500 }
    );
  }
}
