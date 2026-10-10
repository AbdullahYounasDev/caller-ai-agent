#!/usr/bin/env node
/**
 * Verifies the parts of the database schema Prisma cannot police itself.
 *
 * Specifically the HNSW similarity index on `knowledge_chunks.embedding`.
 * Prisma 6 has no `Hnsw` index type, so it cannot be declared in the schema —
 * and because Prisma does not know it exists, `prisma migrate diff` emits a
 * `DROP INDEX` for it on every schema change.
 *
 * Dropping it is SILENT. Nothing errors, no test fails, every query still
 * returns the right answer — each one just falls back to a sequential scan over
 * every chunk the tenant owns. Invisible with 14 chunks; a serious latency
 * problem with 10,000, and by then nobody remembers the migration that did it.
 *
 * Run: npm run db:check   (worth running after any migration)
 */

import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { EMBEDDING_SCHEME_VERSION } from "../src/lib/agent/embed-scheme.js";
import { detectSearchConfig } from "../src/lib/agent/language.js";

const prisma = new PrismaClient();
const problems = [];
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) problems.push(name);
}

try {
  // --- the index Prisma keeps trying to remove -----------------------------
  const indexes = await prisma.$queryRaw`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'ai_engine' AND tablename = 'knowledge_chunks'
  `;

  const hnsw = indexes.find((i) => /hnsw/i.test(i.indexdef));
  record(
    "HNSW similarity index exists",
    Boolean(hnsw),
    hnsw ? hnsw.indexname : "MISSING — a migration dropped it; see schema.prisma"
  );

  // The operator class must match the `<=>` operator used in retrieve.js.
  // A mismatch does not error — Postgres just never uses the index.
  record(
    "index uses vector_cosine_ops (matches the <=> operator)",
    Boolean(hnsw && /vector_cosine_ops/i.test(hnsw.indexdef)),
    hnsw ? "" : "n/a"
  );

  // --- the dimension contract ----------------------------------------------
  const [dims] = await prisma.$queryRaw`
    SELECT DISTINCT vector_dims(embedding) AS dims
    FROM ai_engine.knowledge_chunks
    LIMIT 1
  `;
  if (dims) {
    record(
      "stored vectors are 768-dimensional",
      Number(dims.dims) === 768,
      `found ${dims.dims}`
    );
  } else {
    checks.push({ name: "stored vectors are 768-dimensional", ok: true, detail: "no chunks yet" });
  }

  // --- orphans --------------------------------------------------------------
  const [orphans] = await prisma.$queryRaw`
    SELECT count(*)::int AS n
    FROM ai_engine.knowledge_chunks c
    LEFT JOIN ai_engine.knowledge_sources s ON s.id = c.source_id
    WHERE s.id IS NULL
  `;
  record(
    "no orphaned chunks",
    Number(orphans.n) === 0,
    `${orphans.n} chunk(s) with no document`
  );

  // --- vectors match the code that will query them ---------------------------
  // Anything that changes what is embedded (embed-scheme.js) leaves old rows on
  // the old scheme until `npm run reembed`. That is not an error — same model,
  // same space — but it is a silent skew between chunks and the measured
  // MAX_DISTANCE (§6.3), exactly the kind of thing this script exists to surface.
  const [stale] = await prisma.$queryRaw`
    SELECT count(*)::int AS n
    FROM ai_engine.knowledge_sources
    WHERE status = 'ready' AND embedding_scheme < ${EMBEDDING_SCHEME_VERSION}
  `;
  record(
    `every ready document is embedded under the current scheme (v${EMBEDDING_SCHEME_VERSION})`,
    Number(stale.n) === 0,
    stale.n ? `${stale.n} document(s) behind — run: npm run reembed:dry, then npm run reembed` : ""
  );

  // --- pgvector can do what retrieve.js asks of it ----------------------------
  // retrieve.js turns on `hnsw.iterative_scan` per transaction so a tenant's rows are
  // not silently lost to the post-filter on the shared HNSW index (§6.3). On an older
  // pgvector that setting does not exist and the query would ERROR — better found
  // here, on a new or restored database, than on a customer's call.
  const [ext] = await prisma.$queryRaw`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`;
  const [major, minor] = String(ext?.v ?? "0.0").split(".").map(Number);
  record(
    "pgvector >= 0.8.0 (iterative index scans)",
    major > 0 || minor >= 8,
    `found ${ext?.v ?? "none"}`
  );
  let iterative = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`;
      const [v] = await tx.$queryRaw`SELECT current_setting('hnsw.iterative_scan') AS v`;
      iterative = v.v === "strict_order";
    });
  } catch {
    iterative = false;
  }
  record("hnsw.iterative_scan can be set per transaction", iterative, iterative ? "" : "retrieve.js will fail");

  // --- THE TENANT-FILTER GUARD, ON THE CONNECTION THE APP USES (§6.1, §9.1) --------
  // The guard is a per-transaction setting, which fails SILENTLY when it is not in effect:
  // every query still returns an answer, just from fewer of the tenant's chunks. "The setting
  // can be set" (above) is not "the setting is in effect for retrieval", so three more checks:
  //
  // (1) the code still asks for it. retrieve.js owns the SQL; if someone deletes or edits the
  //     set_config line this is the only thing that notices.
  let source = "";
  try {
    source = readFileSync(new URL("../src/lib/agent/retrieve.js", import.meta.url), "utf8");
  } catch {
    /* reported below */
  }
  const asksForGuard = /set_config\(\s*'hnsw\.iterative_scan'\s*,\s*'strict_order'\s*,\s*true\s*\)/.test(source);
  record(
    "retrieve.js enables iterative scans (strict_order) inside the retrieval transaction",
    asksForGuard,
    asksForGuard ? "" : "the set_config('hnsw.iterative_scan', 'strict_order', true) call is gone — a tenant can silently lose rows (§6.1)"
  );

  // (2) the values really in effect once the app's own statement has run. pgvector's settings only
  //     become real after its library loads (a fresh connection reports them as unset), so a
  //     vector operator runs first — exactly what happens at the start of a retrieval.
  const eff = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`;
    await tx.$queryRaw`SELECT '[1,2,3]'::vector <=> '[1,2,3]'::vector`;
    const [row] = await tx.$queryRaw`SELECT current_setting('hnsw.iterative_scan') AS iterative,
             current_setting('hnsw.max_scan_tuples')::int AS max_scan_tuples,
             current_setting('hnsw.ef_search')::int AS ef_search,
             current_setting('hnsw.scan_mem_multiplier')::float AS mem_multiplier,
             current_setting('work_mem') AS work_mem`;
    return row;
  });
  record(
    "iterative scan is IN EFFECT after the app's statement (strict_order)",
    eff.iterative === "strict_order",
    `effective value: ${eff.iterative}`
  );
  // 20,000 is the documented default and what §6.1 assumes. A lower value set on the database or the
  // role (ALTER DATABASE/ROLE ... SET) shrinks the scan budget without any error anywhere.
  record(
    "hnsw.max_scan_tuples >= 20,000 (the budget §6.1 assumes)",
    eff.max_scan_tuples >= 20000,
    `effective: ${eff.max_scan_tuples}${eff.max_scan_tuples < 20000 ? " — lowered by a database/role setting?" : ""}`
  );
  record(
    "hnsw.ef_search >= 40 (pgvector's default candidate list)",
    eff.ef_search >= 40,
    `effective: ${eff.ef_search}`
  );
  checks.push({
    name: "scan memory (informational)",
    ok: true,
    detail: `work_mem ${eff.work_mem} × hnsw.scan_mem_multiplier ${eff.mem_multiplier}`,
  });

  // (3) the guard WORKS here: a live probe on a TEMP table (it vanishes with the transaction; no tenant
  //     data is read or written). A smooth curve of 8,000 points where a "small tenant" owns every 400th
  //     point — 20 rows spread through a neighbourhood packed with another tenant's. Asked for its 20 rows
  //     the unguarded index returns about 1 (the nearest 40 points overall are nearly all the other
  //     tenant's); the guarded scan keeps walking and returns all 20, because covering 8,000 points is
  //     well inside max_scan_tuples. If that stops being true on this server, connection or pgvector
  //     version, retrieval would be silently starving small tenants.
  //     (Geometry matters and is deliberate: on a blob of near-equidistant random points the HNSW graph
  //     is useless even with NO filter, and a probe there proves nothing — see CLAUDE.md §9.1.)
  const probe = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("CREATE TEMP TABLE guard_probe (id serial, tenant text, embedding vector(3)) ON COMMIT DROP");
      await tx.$executeRawUnsafe(`INSERT INTO guard_probe (tenant, embedding)
        SELECT CASE WHEN g % 400 = 0 THEN 'small' ELSE 'big' END,
               ARRAY[cos(g::float / 8000 * 1.5), sin(g::float / 8000 * 1.5), 1.0]::real[]::vector(3)
        FROM generate_series(1, 8000) g`);
      await tx.$executeRawUnsafe("CREATE INDEX ON guard_probe USING hnsw (embedding vector_cosine_ops)");
      await tx.$executeRawUnsafe("ANALYZE guard_probe");
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off"); // the HNSW plan, as on a large table
      const run = async (mode) => {
        await tx.$executeRawUnsafe(`SELECT set_config('hnsw.iterative_scan', '${mode}', true)`);
        const rows = await tx.$queryRawUnsafe(
          "SELECT id FROM guard_probe WHERE tenant = 'small' ORDER BY embedding <=> (SELECT embedding FROM guard_probe WHERE tenant = 'small' ORDER BY id LIMIT 1) LIMIT 20"
        );
        return rows.length;
      };
      return { without: await run("off"), withGuard: await run("strict_order"), owned: 20 };
    },
    { timeout: 60_000 }
  );
  record(
    "the guard recovers a small tenant's rows on this connection (live probe)",
    probe.withGuard >= 18 && probe.withGuard > probe.without,
    `small tenant owns ${probe.owned} of 8,000 points: ${probe.without} returned without the guard, ${probe.withGuard} with it` +
      (probe.withGuard <= probe.without ? " — THE GUARD IS NOT TAKING EFFECT" : "")
  );

  // --- the keyword index's language columns (§6.3) --------------------------------
  const cols = await prisma.$queryRaw`
    SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attgenerated AS generated
    FROM pg_attribute
    WHERE attrelid = 'ai_engine.knowledge_chunks'::regclass AND attname IN ('search_config', 'content_tsv', 'embed_hash') AND NOT attisdropped`;
  const col = (n) => cols.find((c) => c.name === n);
  record(
    "knowledge_chunks.search_config is a regconfig",
    col("search_config")?.type === "regconfig",
    col("search_config") ? col("search_config").type : "MISSING"
  );
  record(
    "knowledge_chunks.content_tsv is a STORED generated column",
    col("content_tsv")?.type === "tsvector" && col("content_tsv")?.generated === "s",
    col("content_tsv") ? `${col("content_tsv").type}, generated=${col("content_tsv").generated || "no"}` : "MISSING"
  );
  // Without this column ingest cannot tell which stored vectors are reusable (§6.21): it
  // would fail on every INSERT, so a database missing the migration is caught here first.
  record("knowledge_chunks.embed_hash exists (incremental re-embed, §6.21)", col("embed_hash")?.type === "text", col("embed_hash") ? "text" : "MISSING — run prisma migrate deploy");
  // A chunk labelled with the wrong language is not an error — it just ranks worse —
  // which is exactly why it has to be checked: nothing else will ever notice.
  const docs = await prisma.$queryRaw`
    SELECT s.title, s.tenant_id AS tenant, s.content,
           array_agg(DISTINCT c.search_config::text) AS configs
    FROM ai_engine.knowledge_sources s
    JOIN ai_engine.knowledge_chunks c ON c.source_id = s.id
    WHERE s.status = 'ready' GROUP BY s.id`;
  const wrong = docs.filter((d) => d.configs.length !== 1 || d.configs[0] !== detectSearchConfig(d.content));
  record(
    "every chunk is indexed in its document's language",
    wrong.length === 0,
    wrong.length ? `${wrong.length} document(s) mislabelled — run: npm run db:backfill-search` : ""
  );

  console.log("DATABASE CHECKS\n");
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  — ${c.detail}` : ""}`);
  }

  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s).`);
    // Only say this when it is the problem — a stale-scheme failure is fixed by
    // `npm run reembed`, and pointing at the index there sends someone the wrong way.
    if (problems.some((p) => /HNSW|vector_cosine_ops/.test(p))) {
      console.error(
        "  If the HNSW index is missing, recreate it:\n" +
          "    CREATE INDEX knowledge_chunks_embedding_idx ON ai_engine.knowledge_chunks\n" +
          "      USING hnsw (embedding ai_engine.vector_cosine_ops);\n"
      );
    }
    // exitCode, not process.exit(): see the note in scripts/reembed.mjs.
    process.exitCode = 1;
  } else {
    console.log("\n✓ all good");
  }
} catch (err) {
  console.error("db check failed:", err.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
