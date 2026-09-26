-- Background import jobs.
--
-- Embedding a large PDF, and OCR of a scanned one, take far longer than an HTTP
-- request should stay open. Uploads now queue and return a job id; this table
-- is what makes progress observable, and observable ACROSS A PAGE RELOAD —
-- which in-memory progress could never be.
--
-- NOTE: the generated diff for this change also wanted to DROP
-- knowledge_chunks_embedding_idx, because Prisma 6 cannot represent an HNSW
-- index and therefore believes it should not exist. That line was removed
-- deliberately. See the warning on KnowledgeChunk in schema.prisma.

CREATE TABLE "ingest_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_id" TEXT,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'file',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "items_done" INTEGER NOT NULL DEFAULT 0,
    "items_total" INTEGER NOT NULL DEFAULT 0,
    "file_name" TEXT,
    "byte_size" INTEGER,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ingest_jobs_pkey" PRIMARY KEY ("id")
);

-- The dashboard polls "what is running for this tenant", so that is the index.
CREATE INDEX "ingest_jobs_tenant_id_status_idx" ON "ingest_jobs"("tenant_id", "status");
