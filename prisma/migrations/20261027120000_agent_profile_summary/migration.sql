-- Each agent's business summary (CLAUDE.md §6.20, lib/agent/profile-summary.js): an overview the AI
-- wrote from documents the owner chose and the owner approved, always in the agent's prompt, and the
-- documents it came from (so the console can say when one has changed since).
--
-- Hand-written from `prisma migrate diff`, with the `DROP INDEX "knowledge_chunks_embedding_idx"`
-- line REMOVED — the HNSW index Prisma cannot see (§6.1). Every existing agent gets no summary,
-- so nothing it says changes until an owner writes one.

ALTER TABLE "agent_configs" ADD COLUMN     "profile_summary" TEXT,
ADD COLUMN     "profile_summary_sources" JSONB NOT NULL DEFAULT '[]';
