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

import { PrismaClient } from "@prisma/client";

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

  console.log("DATABASE CHECKS\n");
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  — ${c.detail}` : ""}`);
  }

  if (problems.length) {
    console.error(
      `\n✗ ${problems.length} problem(s).\n` +
        "  If the HNSW index is missing, recreate it:\n" +
        "    CREATE INDEX knowledge_chunks_embedding_idx ON ai_engine.knowledge_chunks\n" +
        "      USING hnsw (embedding ai_engine.vector_cosine_ops);\n"
    );
    process.exit(1);
  }
  console.log("\n✓ all good");
} catch (err) {
  console.error("db check failed:", err.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
