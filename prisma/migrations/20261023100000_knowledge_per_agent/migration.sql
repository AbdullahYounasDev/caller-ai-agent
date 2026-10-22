-- Which agents may answer from which documents (CLAUDE.md §6.28). A document with no row here is
-- SHARED by every agent of its tenant — which is what every existing document is, so applying this
-- migration changes no answer. A document with rows is used only by those agents.
--
-- Hand-written from `prisma migrate diff`, with the `DROP INDEX "knowledge_chunks_embedding_idx"`
-- line REMOVED — the HNSW index Prisma cannot see (§6.1).

CREATE TABLE "knowledge_source_agents" (
    "source_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_source_agents_pkey" PRIMARY KEY ("source_id","agent_id")
);

CREATE INDEX "knowledge_source_agents_agent_id_idx" ON "knowledge_source_agents"("agent_id");
CREATE INDEX "knowledge_source_agents_tenant_id_idx" ON "knowledge_source_agents"("tenant_id");

ALTER TABLE "knowledge_source_agents" ADD CONSTRAINT "knowledge_source_agents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_source_agents" ADD CONSTRAINT "knowledge_source_agents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
