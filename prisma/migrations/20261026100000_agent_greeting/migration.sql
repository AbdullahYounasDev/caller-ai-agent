-- Each agent's call greeting and its call-recording switch (CLAUDE.md §6.24, lib/voice/greeting.js).
--
-- Hand-written from `prisma migrate diff`, with the `DROP INDEX "knowledge_chunks_embedding_idx"`
-- line REMOVED — the HNSW index Prisma cannot see (§6.1). Every existing agent gets an empty
-- greeting (= the built-in one, which now tells the caller they are speaking with an AI
-- assistant) and recording off (so nothing is said about recording).

ALTER TABLE "agent_configs" ADD COLUMN     "greeting" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "record_calls" BOOLEAN NOT NULL DEFAULT false;
