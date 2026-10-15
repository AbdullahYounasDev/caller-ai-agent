-- The agent's voice on calls, per spoken language (CLAUDE.md §6.24, src/lib/voice/speech/voices.js).
--
-- Hand-written from `prisma migrate diff`, with its first line REMOVED: the diff opens with
-- `DROP INDEX "knowledge_chunks_embedding_idx"` — the HNSW index Prisma cannot see (§6.1).
-- This migration deliberately drops nothing.
--
-- Defaults to {} = every language speaks with its default voice, which is exactly what
-- every existing tenant had before this column existed.

-- AlterTable
ALTER TABLE "agent_configs" ADD COLUMN     "voices" JSONB NOT NULL DEFAULT '{}';
