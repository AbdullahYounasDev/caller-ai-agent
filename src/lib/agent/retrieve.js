import { prisma } from "@/lib/db";
import { embedText } from "./llm";

/**
 * Embed a question and find the tenant's most relevant knowledge chunks.
 *
 * ── THE RELEVANCE THRESHOLD ──────────────────────────────────────────────
 * This used to return the top 5 chunks unconditionally. Nearest-neighbour
 * search ALWAYS returns something: ask a dental clinic's agent about car
 * insurance and it happily hands back the five least-unrelated paragraphs it
 * owns. Those then went into the prompt as "REFERENCE MATERIAL", and the only
 * thing standing between them and a confidently wrong answer was the grounding
 * rule — a model instruction, which is a request, not a guarantee.
 *
 * Now anything beyond MAX_DISTANCE is dropped. When nothing clears the bar the
 * result is an EMPTY array, the prompt says so plainly, and the agent says it
 * doesn't know. That is a much stronger guarantee than asking the model to
 * ignore material we put in front of it.
 *
 * The number is cosine DISTANCE (pgvector's `<=>`): 0 is identical, 1 is
 * unrelated, 2 is opposite.
 *
 * 0.43 IS MEASURED, NOT GUESSED. `npm run eval:sweep` puts a fixture of real
 * questions through the pipeline and reports the boundary:
 *
 *     hardest question that SHOULD be answered : 0.395
 *     closest question that should NOT be      : 0.456
 *
 * 0.43 is the midpoint of that gap — every answerable question clears it, every
 * off-topic one is rejected. The first value tried here was 0.62, which looked
 * reasonable and rejected NOTHING: the sweep is what caught that, which is why
 * this number must never be changed by feel.
 *
 * RE-RUN THE SWEEP after changing the embedding model, the chunker, or chunk
 * size. All three move these distances, and a threshold tuned for the old
 * pipeline silently becomes either too loose or too strict for the new one.
 * ─────────────────────────────────────────────────────────────────────────
 */
export const MAX_DISTANCE = 0.43;
const DEFAULT_TOP_K = 5;

/**
 * How many threshold-admitted chunks to pull before re-ranking, vs. how many
 * make it into the final answer (topK). Pure vector order alone decides the
 * naive top-5; pulling a wider, still-threshold-admitted pool gives the
 * keyword signal below room to promote an exact match that ranked, say, 9th
 * by cosine distance but contains the literal price/code/name asked about.
 */
const CANDIDATE_POOL_SIZE = 20;

/** Reciprocal Rank Fusion constant. Large relative to the pool size so one
 *  rank position doesn't swing a chunk's combined score disproportionately —
 *  60 is the standard value from the original RRF paper and needs no tenant-
 *  specific tuning the way MAX_DISTANCE did. */
const RRF_K = 60;

/**
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.query - the customer's raw question
 * @param {number} [args.topK]
 * @param {number} [args.maxDistance] - override, used by the eval harness
 * @returns {Promise<Array<{id: string, sourceTitle: string, heading: string|null, content: string, distance: number}>>}
 */
export async function retrieveRelevantChunks({
  tenantId,
  query,
  topK = DEFAULT_TOP_K,
  maxDistance = MAX_DISTANCE,
}) {
  const queryEmbedding = await embedText(query);
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  // STAGE 1 — VECTOR SEARCH DECIDES WHAT IS ADMITTED AT ALL. `<=>` is cosine
  // distance (lower = more similar); $queryRaw because Prisma Client cannot
  // express a vector operator. The MAX_DISTANCE gate is untouched by anything
  // below — it is still the only thing that decides membership, exactly as
  // measured (see the long comment above). What changes is how many
  // threshold-admitted candidates are pulled (CANDIDATE_POOL_SIZE, not just
  // topK) and in what order the final topK are chosen from that pool.
  //
  // Postgres full-text rank is computed here too, on the SAME row set —
  // never a separate keyword query over the whole table, so this can never
  // admit a chunk vector search wouldn't already have allowed. `english` is
  // a fixed text-search config; it under-serves Italian content (a known,
  // acceptable limitation — see below), but degrades to pure vector ranking
  // rather than breaking, since a language mismatch just yields a
  // near-uniform keyword rank that contributes ~nothing to the fused score.
  const candidates = await prisma.$queryRaw`
    SELECT c.id,
           c.source_title AS "sourceTitle",
           c.heading,
           c.content,
           s.updated_at AS "sourceUpdatedAt",
           c.embedding <=> ${vectorLiteral}::vector AS distance,
           ts_rank_cd(to_tsvector('english', c.content), plainto_tsquery('english', ${query})) AS "keywordRank"
    FROM ai_engine.knowledge_chunks c
    JOIN ai_engine.knowledge_sources s ON s.id = c.source_id
    WHERE c.tenant_id = ${tenantId}
      AND c.embedding <=> ${vectorLiteral}::vector <= ${maxDistance}
    ORDER BY distance ASC
    LIMIT ${CANDIDATE_POOL_SIZE}
  `;

  if (!candidates.length) return [];

  // STAGE 2 — HYBRID RE-RANK. Pure cosine similarity is a single lens: it
  // finds semantically related text but has no special regard for exact
  // tokens, so a chunk holding the literal price, order code or name a
  // customer asked about can rank below a chunk merely "about the same
  // topic". Reciprocal Rank Fusion blends the vector rank with the keyword
  // rank computed above — a chunk strong on EITHER signal rises, without
  // either signal alone deciding membership (that's still MAX_DISTANCE).
  const byKeyword = [...candidates].sort((a, b) => Number(b.keywordRank) - Number(a.keywordRank));
  const vectorRank = new Map(candidates.map((c, i) => [c.id, i]));
  const keywordRank = new Map(byKeyword.map((c, i) => [c.id, i]));
  const fused = candidates
    .map((c) => ({
      ...c,
      score: 1 / (RRF_K + vectorRank.get(c.id)) + 1 / (RRF_K + keywordRank.get(c.id)),
    }))
    .sort((a, b) => b.score - a.score);

  // STAGE 3 — DIVERSITY. Five near-duplicate chunks from the same heading (a
  // long price table split into sub-chunks, say) crowd out other material
  // that might matter more to the actual question. One pass round-robins
  // across DISTINCT headings in fused-score order — the single best chunk
  // from every heading before a second chunk from any of them — which is a
  // cheap proxy for MMR that needs no extra embedding comparisons.
  const byHeading = new Map();
  for (const c of fused) {
    const key = c.heading ?? "";
    if (!byHeading.has(key)) byHeading.set(key, []);
    byHeading.get(key).push(c);
  }
  // Groups visited in order of their OWN best chunk's score, so the overall
  // ranking priority among headings survives the round-robin.
  const headingGroups = [...byHeading.values()].sort((a, b) => b[0].score - a[0].score);

  const selected = [];
  for (let round = 0; selected.length < topK && headingGroups.some((g) => g[round]); round++) {
    for (const group of headingGroups) {
      if (selected.length >= topK) break;
      if (group[round]) selected.push(group[round]);
    }
  }

  return selected.slice(0, topK).map(({ score, keywordRank: _kw, ...rest }) => rest);
}

/**
 * Same search, ignoring the threshold — for the eval harness and for debugging
 * "why didn't it find that?", where the distances of the REJECTED chunks are
 * exactly the information you need.
 *
 * Never call this from the agent: returning material the threshold rejected is
 * the behaviour the threshold exists to prevent.
 */
export async function retrieveWithoutThreshold({ tenantId, query, topK = DEFAULT_TOP_K }) {
  const queryEmbedding = await embedText(query);
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  return prisma.$queryRaw`
    SELECT id,
           source_title AS "sourceTitle",
           heading,
           content,
           embedding <=> ${vectorLiteral}::vector AS distance
    FROM ai_engine.knowledge_chunks
    WHERE tenant_id = ${tenantId}
    ORDER BY distance ASC
    LIMIT ${topK}
  `;
}
