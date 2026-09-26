import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { retrieveWithoutThreshold, MAX_DISTANCE } from "@/lib/agent/retrieve";

/**
 * RETRIEVAL DEBUG + EVALUATION endpoint.
 *
 *   GET /api/knowledge/search?tenantId=…&q=…&topK=5
 *   GET /api/knowledge/search?tenantId=…&meta=1   → just the live threshold
 *
 * Returns matches WITH their cosine distances and WITHOUT applying the
 * relevance threshold. Both are deliberate:
 *
 *   - the distances are the only way to set the threshold by evidence rather
 *     than by feel, and to answer "why didn't it find that?" — which is usually
 *     answered by the distance of the chunk it *should* have found;
 *   - leaving the threshold off means one run of the eval harness can be scored
 *     at every candidate threshold, instead of re-querying the model for each.
 *
 * `kept` marks what the agent would actually have seen, so the raw view and the
 * real behaviour never have to be reconciled by hand.
 *
 * Internal-auth guarded. This is a diagnostic surface over a tenant's private
 * knowledge — it must never be reachable from a browser on a public page, and
 * the agent must never call it (see the note in retrieve.js).
 */
export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const params = request.nextUrl.searchParams;
    const tenantId = params.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    // Lets a caller read the live threshold without spending an embedding call.
    if (params.get("meta")) {
      return NextResponse.json({ threshold: MAX_DISTANCE });
    }

    const query = params.get("q");
    if (!query?.trim()) {
      return NextResponse.json({ error: "q is required" }, { status: 400 });
    }

    const topK = Math.min(Number(params.get("topK") ?? 5) || 5, 25);
    const rows = await retrieveWithoutThreshold({ tenantId, query, topK });

    return NextResponse.json({
      query,
      threshold: MAX_DISTANCE,
      results: rows.map((r) => ({
        sourceTitle: r.sourceTitle,
        heading: r.heading,
        // Postgres returns the distance as a string via $queryRaw in some
        // drivers; the eval does arithmetic on it, so coerce here rather than
        // making every caller remember.
        distance: Number(r.distance),
        kept: Number(r.distance) <= MAX_DISTANCE,
        preview: r.content.slice(0, 160),
      })),
    });
  } catch (err) {
    console.error("GET /api/knowledge/search failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
