-- Whether a conversation's agent keeps failing to understand the caller, and whether the
-- conversation has been passed to a person (CLAUDE.md §6.26).
--
-- Hand-written from `prisma migrate diff`, with its first statement REMOVED: the diff opens with
-- `DROP INDEX "knowledge_chunks_embedding_idx"` — the HNSW index Prisma cannot see (§6.1).
-- This migration drops nothing and changes no existing row.

ALTER TABLE "conversations" ADD COLUMN "handoff_state" JSONB;
