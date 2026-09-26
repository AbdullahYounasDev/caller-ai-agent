-- Documents become first-class records, so a business can replace, edit and
-- delete what it gave its agent. Previously chunks carried only a free-text
-- `source` label with no identity, which is why ingest could only ever append.
--
-- This migration PRESERVES existing chunks by reconstructing a document for
-- each distinct label, rather than dropping knowledge a tenant already has.

-- 1. The new table.
CREATE TABLE "knowledge_sources" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT,
    "byte_size" INTEGER,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- 2. New chunk columns, NULLABLE for now so the backfill can run.
ALTER TABLE "knowledge_chunks"
  ADD COLUMN "heading"      TEXT,
  ADD COLUMN "ordinal"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "source_id"    TEXT,
  ADD COLUMN "source_title" TEXT;

-- 3. Backfill: one document per distinct (tenant, label). Its `content` is the
--    chunks stitched back together in insertion order — an approximation of the
--    original, but a faithful enough one to re-read and edit, which is the
--    point of storing it.
INSERT INTO "knowledge_sources" (id, tenant_id, title, kind, content, chunk_count, status, created_at, updated_at)
SELECT
  gen_random_uuid(),
  c.tenant_id,
  c.source,
  'text',
  string_agg(c.content, E'\n\n' ORDER BY c.created_at, c.id),
  count(*)::int,
  'ready',
  min(c.created_at),
  now()
FROM "knowledge_chunks" c
GROUP BY c.tenant_id, c.source;

UPDATE "knowledge_chunks" c
SET source_id    = s.id,
    source_title = s.title
FROM "knowledge_sources" s
WHERE s.tenant_id = c.tenant_id
  AND s.title     = c.source;

-- 4. Any chunk the backfill could not place is orphaned and unreachable —
--    removing it is the honest outcome, and there should be none.
DELETE FROM "knowledge_chunks" WHERE source_id IS NULL;

-- 5. Now the columns can carry their real constraints.
ALTER TABLE "knowledge_chunks"
  ALTER COLUMN "source_id"    SET NOT NULL,
  ALTER COLUMN "source_title" SET NOT NULL,
  DROP COLUMN "source";

-- 6. Keys and indexes.
CREATE INDEX "knowledge_sources_tenant_id_idx" ON "knowledge_sources"("tenant_id");
CREATE UNIQUE INDEX "knowledge_sources_tenant_id_title_key" ON "knowledge_sources"("tenant_id", "title");
CREATE INDEX "knowledge_chunks_source_id_idx" ON "knowledge_chunks"("source_id");

ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. THE SIMILARITY INDEX.
--
-- Without it every question is a sequential scan computing cosine distance
-- against every chunk the tenant owns — invisible at 14 chunks, a real latency
-- problem at 10,000, and it degrades linearly all the way there.
--
-- HNSW rather than IVFFlat: it needs no training pass, so it works on an empty
-- table and stays correct as rows arrive, whereas IVFFlat must be rebuilt after
-- the data grows or its recall quietly collapses.
--
-- vector_cosine_ops MUST match the `<=>` operator used in retrieve.js. A
-- mismatch does not error — Postgres simply ignores the index and silently goes
-- back to a sequential scan.
CREATE INDEX "knowledge_chunks_embedding_idx"
  ON "knowledge_chunks"
  USING hnsw ("embedding" ai_engine.vector_cosine_ops);
