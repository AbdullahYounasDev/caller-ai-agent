import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { embedText } from "./llm";
import { buildKeywordQuery } from "./keyword-query";
import { EMBEDDING_SCHEME_VERSION } from "./embed-scheme";

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
 * KEYWORD QUERY MODE — OFF. Do not turn on without the integrated eval (CLAUDE.md §6.22).
 *
 * `plainto_tsquery` ANDs every word, so a sentence-length question needs a chunk that
 * contains ALL of them and the keyword half of the hybrid ranking contributes ~0.
 * `true` replaces it with the question's content words OR-ed together
 * (keyword-query.js), ranked with `ts_rank_cd` length-normalisation
 * KEYWORD_RANK_NORMALIZATION.
 *
 * MEASURED KEYWORD-ONLY (npm run eval:keyword — SQL over the 58 stored chunks of the
 * eval corpus, NO vectors, 94 questions; hit@1 / hit@3 / any-signal; "overall" excludes
 * conflict and follow-ups, which need the conversation-aware path):
 *
 *                                AND (today)      OR            OR + norm 1
 *   factual (24)                  8 /  8 /  8    63 / 75 /100   79 / 96 /100
 *   phrased_loosely (11)          0 /  0 /  0    36 / 64 /100   55 / 91 /100
 *   cross_language (10)           0 /  0 /  0    50 / 60 / 90   60 / 70 / 90
 *   generic_overview (8)          0 /  0 / 25    13 / 38 / 63   38 / 38 / 63
 *   report_phrasings (7)          0 / 29 / 43     0 / 71 / 86   57 / 71 / 86
 *   OVERALL (n=60)                3 /  7 / 12    42 / 65 / 92   63 / 80 / 92
 *
 * i.e. today the keyword half has NO signal for 88% of questions. Norm 2 (divide by
 * length) and norm 8 (unique words) scored 50-52 / 82 overall: slightly better hit@3,
 * clearly worse hit@1 (long chunks are over-penalised); norm 1 won. `websearch_to_tsquery`
 * is IDENTICAL to AND on a plain sentence (it only ORs a literal "or"), so it is not a
 * candidate. Italian questions: AND matched an Italian chunk for 2 of 10, OR for 8 of 10,
 * and the Italian document was the top keyword hit for 6 of 7 that had any signal.
 *
 * WHAT THIS DOES NOT PROVE: keyword score only RE-ORDERS the vector-admitted pool; it can
 * never admit a chunk (§6.3), and these numbers have no vector search in them. Whether
 * a noisier keyword rank helps or hurts the fused ranking — especially cross_language,
 * off-topic leaks and the report phrasings — is only knowable from `eval:real`.
 */
export const USE_OR_KEYWORD_QUERY = false;
/** `ts_rank_cd` normalisation bitmask used with the OR query: 1 = divide by 1 + log(length). */
export const KEYWORD_RANK_NORMALIZATION = 1;

/**
 * QUERY EMBEDDINGS ARE CACHED. Embedding the question is a round trip to the embedding
 * API — measured ~0.8–1.1 s of every voice turn on the free tier (§6.24), and one unit of
 * the ~1000/day embedding quota (§8 limitation 3). The same text always embeds to the same
 * vector, and callers ask the same few questions all day ("what are your opening hours?"),
 * so an exact repeat is answered from memory.
 *
 * Keyed by the EXACT text (trimmed only — normalising case or punctuation would hand one
 * text the vector of another, a small unmeasured change to retrieval) AND by
 * EMBEDDING_SCHEME_VERSION, so a vector from another scheme can never be reused (§6.2).
 * In-process and bounded, like every cache here (§8 limitation 9).
 */
const QUERY_EMBEDDING_CACHE_SIZE = 1000;
const queryEmbeddings = new Map();

/**
 * @param {string} query
 * @param {(text: string, options: {role: "query"}) => Promise<number[]>} [embed] injectable for tests
 * @returns {Promise<number[]>}
 */
export async function embedQuery(query, embed = embedText) {
  const key = `${EMBEDDING_SCHEME_VERSION}\u0000${String(query).trim()}`;
  if (queryEmbeddings.has(key)) {
    const vector = queryEmbeddings.get(key);
    queryEmbeddings.delete(key); // refresh LRU position
    queryEmbeddings.set(key, vector);
    return vector;
  }
  const vector = await embed(String(query).trim(), { role: "query" });
  queryEmbeddings.set(key, vector);
  if (queryEmbeddings.size > QUERY_EMBEDDING_CACHE_SIZE) queryEmbeddings.delete(queryEmbeddings.keys().next().value);
  return vector;
}

/**
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.query - the customer's raw question
 * @param {number} [args.topK]
 * @param {number} [args.maxDistance] - override, used by the eval harness
 * @param {"and"|"or"} [args.keywordQuery] - override of USE_OR_KEYWORD_QUERY, used by the
 *   eval harness to A/B the keyword query without editing source. The agent never passes it.
 * @returns {Promise<Array<{id: string, sourceTitle: string, heading: string|null, content: string, distance: number}>>}
 */
export async function retrieveRelevantChunks({
  tenantId,
  query,
  topK = DEFAULT_TOP_K,
  maxDistance = MAX_DISTANCE,
  keywordQuery = USE_OR_KEYWORD_QUERY ? "or" : "and",
}) {
  const queryEmbedding = await embedQuery(query);
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  // STAGE 1 — VECTOR SEARCH DECIDES WHAT IS ADMITTED AT ALL. `<=>` is cosine
  // distance (lower = more similar); $queryRaw because Prisma Client cannot
  // express a vector operator. The MAX_DISTANCE gate is untouched by anything
  // below — it is still the only thing that decides membership, exactly as
  // measured (see the long comment above). What changes is how many
  // threshold-admitted candidates are pulled (CANDIDATE_POOL_SIZE, not just
  // topK) and in what order the final topK are chosen from that pool.
  //
  // THE TENANT FILTER IS APPLIED AFTER THE INDEX WALK — and that is silent.
  // One HNSW index spans every tenant. pgvector walks the graph for the
  // `hnsw.ef_search` (default 40) nearest chunks IN THE WHOLE TABLE and only then
  // applies `tenant_id = X` and the distance cap. When the nearest 40 chunks
  // belong to other tenants (every clinic has a pricing page), a tenant that
  // genuinely has matching chunks gets fewer back, or none: EXPLAIN shows
  // "Rows Removed by Filter: 39" beside "rows=1". No error, every answer still
  // looks like an answer — exactly like the dropped index of §6.1.
  //
  // `hnsw.iterative_scan = strict_order` (pgvector >= 0.8.0) makes the scan keep
  // walking until the filtered LIMIT is satisfied or `hnsw.max_scan_tuples`
  // (default 20,000) is reached, instead of stopping at ef_search. It is set with
  // set_config(…, is_local = true) inside THIS transaction, not on the database:
  // it travels with the code, a restored or new database cannot silently lack it,
  // and nothing else's queries are affected. strict_order (not relaxed) because
  // the RRF below takes the SQL order as the vector rank and the order must be
  // exact. When the first ef_search candidates already satisfy the LIMIT it costs
  // nothing — measured ~equal latency (scripts/repro-tenant-recall.mjs).
  // `npm run db:check` asserts the setting exists on this server. The ceiling
  // that remains — max_scan_tuples — is where per-tenant partitioning (§9.1) starts.
  //
  // KEYWORD RANK is computed here too, on the SAME row set — never a separate
  // keyword query over the whole table, so this can never admit a chunk vector
  // search wouldn't already have allowed. It reads the PRECOMPUTED `content_tsv`
  // (generated from `search_config`, chosen per document at ingest — language.js)
  // instead of tokenising every candidate per query, and the QUERY is analysed with
  // each chunk's OWN config: an Italian chunk is matched by an Italian-stemmed
  // tsquery, an English chunk by an English one. Cross-language (an Italian
  // question, an English chunk) contributes only what is language-neutral — a
  // brand, a plan name, a number — and the vector half carries the meaning, as
  // before (eval cross_language, §6.3).
  // An OR query that is empty (nothing but filler: "who are you") falls back to AND, so a
  // question is never handed to Postgres as an empty tsquery. With the mode off this is
  // exactly the SQL that always ran: plainto_tsquery, default ts_rank_cd normalisation.
  const orQuery = keywordQuery === "or" ? buildKeywordQuery(query).tsquery : "";
  // Config names are the fixed literals below, never input, so Prisma.raw is safe here.
  const keywordTsQuery = (cfg) =>
    orQuery
      ? Prisma.sql`to_tsquery(${Prisma.raw(`'${cfg}'`)}, ${orQuery})`
      : Prisma.sql`plainto_tsquery(${Prisma.raw(`'${cfg}'`)}, ${query})`;
  const keywordNorm = orQuery ? Prisma.sql`, ${KEYWORD_RANK_NORMALIZATION}::int` : Prisma.empty;

  const candidates = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`;
    return tx.$queryRaw`
      SELECT c.id,
             c.source_title AS "sourceTitle",
             c.heading,
             c.content,
             s.updated_at AS "sourceUpdatedAt",
             c.embedding <=> ${vectorLiteral}::vector AS distance,
             ts_rank_cd(
               c.content_tsv,
               CASE c.search_config
                 WHEN 'italian'::regconfig THEN ${keywordTsQuery("italian")}
                 WHEN 'simple'::regconfig  THEN ${keywordTsQuery("simple")}
                 ELSE ${keywordTsQuery("english")}
               END${keywordNorm}
             ) AS "keywordRank"
      FROM ai_engine.knowledge_chunks c
      JOIN ai_engine.knowledge_sources s ON s.id = c.source_id
      WHERE c.tenant_id = ${tenantId}
        AND c.embedding <=> ${vectorLiteral}::vector <= ${maxDistance}
      ORDER BY distance ASC
      LIMIT ${CANDIDATE_POOL_SIZE}
    `;
  });

  return rankCandidates(candidates, topK);
}

/**
 * STAGES 2-3 of retrieval, as a PURE function over the rows STAGE 1 returned.
 *
 * Split out of retrieveRelevantChunks so the part with the sharpest edge cases
 * (the RRF fusion and the document-then-heading round-robin of §6.3) can be
 * tested with hand-built rows and no database or embedder. It must stay free of
 * I/O: anything that needs the DB belongs in STAGE 1, where the MAX_DISTANCE gate
 * lives. `candidates` MUST arrive in vector order (nearest first) — that order
 * IS the vector rank.
 *
 * @param {Array<{id: string, sourceTitle: string, heading: string|null, distance: number, keywordRank: number|string}>} candidates
 * @param {number} topK
 * @returns {Array<object>} at most topK rows, without `score` / `keywordRank`
 */
export function rankCandidates(candidates, topK) {
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

  // STAGE 3 — DIVERSITY, on TWO axes, DOCUMENT first and HEADING second.
  //
  // Heading-only round-robin (the original version of this stage) turned out
  // to give ZERO protection for the case it most needed to: two documents
  // that disagree. A single dense, dominant document naturally has many
  // DIFFERENT headings of its own — a "Pro" chunk, a "Plan Comparison" chunk,
  // an intro chunk — so grouping by heading text never even merges it with a
  // competing document's chunk (they don't share a heading key at all); the
  // dominant document's ten distinct headings simply outrank the other
  // document's one relevant chunk on fused score and fill every slot before a
  // second round of selection is ever reached. That silently defeated §6.10's
  // conflict-surfacing rule: the model never saw the contradicting chunk, so
  // it had nothing to flag. Confirmed against the exact fixture that exposed
  // it (a 10-chunk pricing docx vs. a 3-chunk conflicting price list) — the
  // conflicting chunk ranked 11th and never reached a topK of 6.
  //
  // The fix is to round-robin across DOCUMENTS as the primary axis — every
  // document represented before a second chunk from any one of them — and
  // only THEN diversify by heading within each document's own share, which
  // is what still protects the original case this stage was built for (a
  // long price table split into sub-chunks crowding out a different section
  // of the SAME document). `sourceTitle` is unique per tenant
  // (`@@unique([tenantId, title])`), so it is a safe, already-available
  // document identity to key on.
  const bySource = new Map();
  for (const c of fused) {
    if (!bySource.has(c.sourceTitle)) bySource.set(c.sourceTitle, new Map());
    const byHeadingInSource = bySource.get(c.sourceTitle);
    const key = c.heading ?? "";
    if (!byHeadingInSource.has(key)) byHeadingInSource.set(key, []);
    byHeadingInSource.get(key).push(c);
  }

  // Within one document, round-robin its own heading groups into a single
  // ordered list, best chunk first — the same algorithm as before, just
  // scoped per document instead of applied globally.
  const perSourceLists = [...bySource.values()].map((byHeadingInSource) => {
    const headingGroups = [...byHeadingInSource.values()].sort((a, b) => b[0].score - a[0].score);
    const ordered = [];
    for (let round = 0; headingGroups.some((g) => g[round]); round++) {
      for (const group of headingGroups) {
        if (group[round]) ordered.push(group[round]);
      }
    }
    return ordered;
  });
  // Documents visited in order of their OWN best chunk's score, so the
  // overall ranking priority among documents survives the round-robin.
  perSourceLists.sort((a, b) => b[0].score - a[0].score);

  const selected = [];
  for (let round = 0; selected.length < topK && perSourceLists.some((l) => l[round]); round++) {
    for (const list of perSourceLists) {
      if (selected.length >= topK) break;
      if (list[round]) selected.push(list[round]);
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
  const queryEmbedding = await embedText(query, { role: "query" });
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
