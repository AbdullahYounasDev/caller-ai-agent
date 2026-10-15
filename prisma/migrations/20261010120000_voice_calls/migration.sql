-- Voice calls: one row per call, one per exchange, and the call's event timeline
-- (CLAUDE.md §6.24). Written only by the voice gateway (src/lib/voice/calls.js).
--
-- Hand-written from `prisma migrate diff`, with its first line REMOVED: the diff opens
-- with `DROP INDEX "knowledge_chunks_embedding_idx"` — the HNSW index Prisma cannot see
-- (§6.1). This migration deliberately drops nothing.
--
-- call_logs already existed (unused until now); every new column is either nullable or
-- has a default, so no existing row needs a backfill.

-- AlterTable
ALTER TABLE "call_logs" ADD COLUMN     "end_reason" TEXT,
ADD COLUMN     "ended_at" TIMESTAMP(3),
ADD COLUMN     "engine" JSONB,
ADD COLUMN     "from_number" TEXT,
ADD COLUMN     "interruptions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "median_response_ms" INTEGER,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "to_number" TEXT,
ADD COLUMN     "transport" TEXT NOT NULL DEFAULT 'browser',
ADD COLUMN     "turn_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "call_turns" (
    "id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "caller_text" TEXT NOT NULL,
    "agent_text" TEXT NOT NULL,
    "spoken_text" TEXT,
    "interrupted" BOOLEAN NOT NULL DEFAULT false,
    "language" TEXT,
    "intent" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "topic" TEXT,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "search_query" TEXT,
    "rewrite_status" TEXT,
    "model" TEXT,
    "response_ms" INTEGER,
    "timings" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_events" (
    "id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "at_ms" INTEGER NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "call_turns_tenant_id_intent_idx" ON "call_turns"("tenant_id", "intent");

-- CreateIndex
CREATE UNIQUE INDEX "call_turns_call_id_index_key" ON "call_turns"("call_id", "index");

-- CreateIndex
CREATE UNIQUE INDEX "call_events_call_id_seq_key" ON "call_events"("call_id", "seq");

-- CreateIndex
CREATE INDEX "call_logs_tenant_id_created_at_idx" ON "call_logs"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "call_turns" ADD CONSTRAINT "call_turns_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "call_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "call_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
