#!/usr/bin/env node
/**
 * PROBLEM B, REPRODUCED WITH DATA: one HNSW index across ALL tenants, tenant
 * filter applied AFTER the approximate graph walk (§6.1, §6.3).
 *
 * Builds a scratch table (ai_engine.synth_chunks — never the real one) with the
 * SAME index definition as knowledge_chunks, fills it with many synthetic tenants
 * whose chunks cluster around SHARED topics (as real tenants of one vertical do —
 * every clinic has a pricing page), plus one small target tenant on those same
 * topics, then compares what the index returns for the target against an exact
 * (index-off) scan, under each setting. Costs no embeddings: vectors are synthetic.
 *
 * Two geometries, because the problem depends on it (CLAUDE.md §6.3):
 *   default        each tenant's chunks on a topic sit TOGETHER (realistic) — the index copes
 *   --interleaved  tenants' chunks are mixed together — the index silently drops rows
 *
 * Usage:  node scripts/repro-tenant-recall.mjs [--interleaved] [--tenants=24] [--per-tenant=300] [--keep]
 */
import { PrismaClient } from "@prisma/client";

const arg = (n, d) => Number(process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d);
const TENANTS = arg("tenants", 24);
const PER_TENANT = arg("per-tenant", 300);
const TARGET_CHUNKS = 40;
const TOPICS = 30;
const DIMS = 768;
const GATE = 0.43;
const prisma = new PrismaClient();

// small deterministic PRNG so a run is reproducible
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const centers = Array.from({ length: TOPICS }, () => unit(Array.from({ length: DIMS }, gauss)));
// intra-topic cosine distance ≈ 0.2 — the same neighbourhood scale as real chunks
const SIGMA = Math.sqrt(0.25 / DIMS);
const near = (c, s = SIGMA) => unit(c.map((x) => x + s * gauss()));
// Real tenants of one vertical share TOPICS but each words them its own way, so a
// tenant's chunks on a topic sit together, offset from the shared centre. Without this
// every point on a topic is equidistant from every other and the graph degenerates.
// --interleaved: NO per-tenant offset, so every tenant's chunks on a topic are mixed in with
// everyone else's — the worst case for a post-filtered index.
const INTERLEAVED = process.argv.includes("--interleaved");
const OFFSET = INTERLEAVED ? 0 : Math.sqrt(0.12 / DIMS);
const tenantCentre = (c) => (OFFSET ? unit(c.map((x) => x + OFFSET * gauss())) : c);
const lit = (v) => `[${v.map((x) => x.toFixed(5)).join(",")}]`;

async function insert(tenant, vecs) {
  for (let i = 0; i < vecs.length; i += 100) {
    const rows = vecs.slice(i, i + 100).map((v) => `('${tenant}','${lit(v)}')`).join(",");
    await prisma.$executeRawUnsafe(`INSERT INTO ai_engine.synth_chunks (tenant_id, embedding) VALUES ${rows}`);
  }
}

async function run(settings, queries) {
  let recallSum = 0, empty = 0, ms = 0;
  for (const q of queries) {
    const sql = (lim) => `SELECT id FROM ai_engine.synth_chunks WHERE tenant_id='__target__'
      AND embedding <=> '${lit(q)}'::vector <= ${GATE} ORDER BY embedding <=> '${lit(q)}'::vector LIMIT ${lim}`;
    const exact = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_indexscan = off");
      return tx.$queryRawUnsafe(sql(20));
    });
    const t0 = Date.now();
    const got = await prisma.$transaction(async (tx) => {
      // seqscan off = force the HNSW plan, the one the planner picks on a big table.
      // (At this row count it would otherwise scan sequentially and hide the problem.)
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      for (const [k, v] of Object.entries(settings)) await tx.$executeRawUnsafe(`SELECT set_config('${k}','${v}',true)`);
      return tx.$queryRawUnsafe(sql(20));
    });
    ms += Date.now() - t0;
    const want = new Set(exact.map((r) => r.id));
    recallSum += want.size ? got.filter((r) => want.has(r.id)).length / want.size : 1;
    if (!got.length && want.size) empty++;
  }
  return { recall: recallSum / queries.length, empty, ms: ms / queries.length };
}

async function main() {
  await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS ai_engine.synth_chunks");
  await prisma.$executeRawUnsafe(
    "CREATE TABLE ai_engine.synth_chunks (id serial PRIMARY KEY, tenant_id text NOT NULL, embedding ai_engine.vector(768) NOT NULL)"
  );
  console.log(`generating ${TENANTS} tenants × ${PER_TENANT} chunks + 1 target tenant × ${TARGET_CHUNKS}…`);
  for (let t = 0; t < TENANTS; t++) {
    const mine = centers.map(tenantCentre); // this tenant's own phrasing of each topic
    await insert(`t${t}`, Array.from({ length: PER_TENANT }, () => near(mine[Math.floor(rnd() * TOPICS)])));
  }
  const targetTopics = [0, 3, 7, 11, 19];
  const targetCentres = centers.map(tenantCentre);
  const targetVecs = Array.from({ length: TARGET_CHUNKS }, (_, i) => near(targetCentres[targetTopics[i % targetTopics.length]]));
  await insert("__target__", targetVecs);
  // SAME definition as knowledge_chunks_embedding_idx (§6.1), built AFTER the load.
  await prisma.$executeRawUnsafe("CREATE INDEX synth_embedding_idx ON ai_engine.synth_chunks USING hnsw (embedding ai_engine.vector_cosine_ops)");
  await prisma.$executeRawUnsafe("ANALYZE ai_engine.synth_chunks");

  // A real question is a FRESH point on a topic, not a copy of one of the target's own
  // chunks — and on a shared topic, other tenants' chunks are as close to it as the
  // target's. (Queries built from the target's own chunks always find them first, and
  // hide the problem completely: that was this script's first, wrong, version.)
  // GENERIC questions: the shared topic centre, not any one tenant's phrasing of it.
  // Interleaved: ask from a point ON one of the target's own chunks.
  const queries = INTERLEAVED ? targetVecs : targetVecs.map((_, i) => near(centers[targetTopics[i % targetTopics.length]], SIGMA / 3));
  const configs = [
    ["default  (ef_search 40, no iterative scan)", {}],
    ["ef_search 200", { "hnsw.ef_search": 200 }],
    ["ef_search 1000 (the maximum)", { "hnsw.ef_search": 1000 }],
    ["iterative_scan = relaxed_order", { "hnsw.iterative_scan": "relaxed_order" }],
    ["iterative_scan = strict_order", { "hnsw.iterative_scan": "strict_order" }],
  ];
  const total = TENANTS * PER_TENANT + TARGET_CHUNKS;
  console.log(`\n${total} chunks total; the target tenant owns ${TARGET_CHUNKS} of them (${((100 * TARGET_CHUNKS) / total).toFixed(1)}%)`);
  console.log(`${queries.length} target queries, each compared with an exact index-off scan of the same tenant\n`);
  console.log("setting".padEnd(46) + "recall".padStart(8) + "  zero-result".padStart(14) + "  avg ms".padStart(9));
  for (const [name, s] of configs) {
    const r = await run(s, queries);
    console.log(name.padEnd(46) + `${(r.recall * 100).toFixed(0)}%`.padStart(8) + `${r.empty}/${queries.length}`.padStart(14) + r.ms.toFixed(1).padStart(9));
  }
  // Which plan does the PLANNER pick for the target tenant on its own? A tenant_id btree
  // (as knowledge_chunks has) lets a selective tenant be read exactly instead.
  await prisma.$executeRawUnsafe("CREATE INDEX synth_tenant_idx ON ai_engine.synth_chunks (tenant_id)");
  await prisma.$executeRawUnsafe("ANALYZE ai_engine.synth_chunks");
  const plan = async (tenant) =>
    (await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL search_path = ai_engine, public");
      return tx.$queryRawUnsafe(`EXPLAIN SELECT id FROM synth_chunks WHERE tenant_id='${tenant}' AND embedding <=> '${lit(queries[0])}'::vector <= ${GATE} ORDER BY embedding <=> '${lit(queries[0])}'::vector LIMIT 20`);
    })).map((r) => r["QUERY PLAN"]).join(" ");
  const kind = (p) => (/hnsw/i.test(p) ? "HNSW index" : /synth_tenant_idx/.test(p) ? "tenant_id btree + sort (exact)" : "sequential scan");
  console.log(`
planner's own choice with a tenant_id btree present:  target tenant (40 rows) → ${kind(await plan("__target__"))};  tenant t0 (${PER_TENANT} rows) → ${kind(await plan("t0"))}`);
  if (!process.argv.includes("--keep")) await prisma.$executeRawUnsafe("DROP TABLE ai_engine.synth_chunks");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
