import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { retrieveWithoutThreshold, retrieveRelevantChunks, MAX_DISTANCE } from "@/lib/agent/retrieve";
import {
  retrieveForTurn,
  needsContext,
  isAcknowledgement,
  QUERY_STRATEGIES,
  DEFAULT_QUERY_STRATEGY,
} from "@/lib/agent/query";

/**
 * RETRIEVAL DEBUG + EVALUATION endpoint.
 *
 *   GET /api/knowledge/search?tenantId=…&q=…&topK=5            raw, pure-vector, unfiltered
 *   GET /api/knowledge/search?tenantId=…&q=…&topK=5&real=1     the REAL path — see below
 *   GET /api/knowledge/search?tenantId=…&meta=1                → just the live threshold
 *   POST /api/knowledge/search?tenantId=…  { q, history, strategy }   → the conversation-aware path (see POST below)
 *
 * DEFAULT MODE returns matches WITH their cosine distances and WITHOUT
 * applying the relevance threshold. Both are deliberate:
 *
 *   - the distances are the only way to set the threshold by evidence rather
 *     than by feel, and to answer "why didn't it find that?" — which is usually
 *     answered by the distance of the chunk it *should* have found;
 *   - leaving the threshold off means one run of the eval harness can be scored
 *     at every candidate threshold, instead of re-querying the model for each.
 *
 * `kept` marks what the agent would actually have seen — for THIS mode. It is
 * still a proxy: pure-vector order is NOT what the agent's prompt is actually
 * built from once a tenant has more than one relevant document (§6.3's hybrid
 * RRF re-rank + document/heading diversity stage changes both membership order
 * and which chunks survive `topK`). An eval scored only against this mode can
 * report numbers for a retriever the agent doesn't run — that is exactly the
 * gap `&real=1` below exists to close.
 *
 * `&real=1` MODE calls `retrieveRelevantChunks()` — the EXACT function
 * `respond.js` calls — so every result returned is genuinely KEPT (already
 * threshold-admitted, hybrid-re-ranked and diversity-selected) and `rank` is
 * its position in the list the agent's prompt would actually receive. This
 * route still never becomes a channel the agent depends on: it is read-only,
 * internal-auth guarded, and exists solely so an eval script can observe the
 * real pipeline over HTTP the same way it already observes the raw one — see
 * scripts/eval-retrieval-real.mjs.
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
    // Debug-only A/B of the keyword query (retrieve.js USE_OR_KEYWORD_QUERY); absent = the shipped mode.
    const keywordQuery = ["and", "or"].includes(params.get("keyword")) ? params.get("keyword") : undefined;

    if (params.get("real")) {
      const kept = await retrieveRelevantChunks({ tenantId, query, topK, keywordQuery });
      return NextResponse.json({
        query,
        mode: "real",
        threshold: MAX_DISTANCE,
        results: kept.map((r, i) => ({
          rank: i + 1,
          sourceTitle: r.sourceTitle,
          heading: r.heading,
          distance: Number(r.distance),
          preview: r.content.slice(0, 160),
        })),
      });
    }

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

/**
 * POST /api/knowledge/search?tenantId=…
 *   { q, history?: [{role: "user"|"assistant", text}], topK?, strategy?, decideOnly? }
 *
 * The CONVERSATION-AWARE real path (§6.19): calls `retrieveForTurn()`, the exact
 * function `respond()` calls, so an eval can score follow-ups ("and the Pro
 * one?") with the conversation that gives them meaning. `strategy` overrides
 * the shipped default ("raw" | "concat" | "rewrite") and exists ONLY so the
 * strategies can be measured against each other — respond() never accepts it.
 *
 * `decideOnly` returns just the cheap local trigger verdict (needsContext) and
 * spends nothing: no embedding, no model call. It is how the eval measures how
 * often the trigger fires on standalone questions without paying to find out.
 *
 * Same standing as GET above: read-only, internal-auth guarded, never used by
 * the agent. A rewrite call here DOES spend chat quota (one per triggered turn).
 */
export async function POST(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const q = String(body?.q ?? "");
    if (!q.trim()) return NextResponse.json({ error: "q is required" }, { status: 400 });

    if (body?.decideOnly) {
      return NextResponse.json({
        needsContext: needsContext(q),
        acknowledgement: isAcknowledgement(q),
      });
    }

    const strategy = body?.strategy ?? DEFAULT_QUERY_STRATEGY;
    if (!QUERY_STRATEGIES.includes(strategy)) {
      return NextResponse.json({ error: `strategy must be one of ${QUERY_STRATEGIES.join(", ")}` }, { status: 400 });
    }

    const history = (Array.isArray(body?.history) ? body.history : []).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.text ?? m.content ?? ""),
    }));
    const topK = Math.min(Number(body?.topK ?? 5) || 5, 25);

    // Debug-only: lets the eval give the rewrite a long budget so the strategy's QUALITY
    // is measured apart from the provider's latency (capped; respond() never passes it).
    const rewriteTimeoutMs = Math.min(Number(body?.rewriteTimeoutMs) || 0, 15000) || undefined;

    const keywordQuery = ["and", "or"].includes(body?.keyword) ? body.keyword : undefined;

    const turn = await retrieveForTurn({ tenantId, message: q, history, topK, strategy, rewriteTimeoutMs, keywordQuery });

    return NextResponse.json({
      query: q,
      mode: "real-turn",
      strategy,
      threshold: MAX_DISTANCE,
      searchQuery: turn.searchQuery,
      trigger: turn.trigger,
      rewrite: turn.rewrite,
      results: turn.chunks.map((r, i) => ({
        rank: i + 1,
        sourceTitle: r.sourceTitle,
        heading: r.heading,
        distance: Number(r.distance),
        preview: r.content.slice(0, 160),
      })),
    });
  } catch (err) {
    console.error("POST /api/knowledge/search failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
