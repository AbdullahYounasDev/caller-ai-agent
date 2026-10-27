-- Each agent's call-ending settings (CLAUDE.md §6.24, lib/voice/closing.js): does the call end by
-- itself once the conversation is over, and after how many seconds of quiet.
--
-- Hand-written from `prisma migrate diff`, with the `DROP INDEX "knowledge_chunks_embedding_idx"`
-- line REMOVED — the HNSW index Prisma cannot see (§6.1). Every existing agent gets the switch ON
-- and 3 seconds: calls already ended themselves 2.5 s after a goodbye, so behaviour barely moves.

ALTER TABLE "agent_configs" ADD COLUMN     "auto_end_calls" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "end_call_delay_seconds" INTEGER NOT NULL DEFAULT 3;
