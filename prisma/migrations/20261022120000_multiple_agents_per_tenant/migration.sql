-- A tenant can have several agents (CLAUDE.md §6.27). An agent is one agent_configs row; the
-- engine is the one brain every agent uses.
--
-- Hand-written from `prisma migrate diff`, with the `DROP INDEX "knowledge_chunks_embedding_idx"`
-- line REMOVED — the HNSW index Prisma cannot see (§6.1).
--
-- Nothing changes for an existing tenant: its one row becomes its DEFAULT agent, and every
-- conversation, call and request it already has is stamped with that agent. A tenant with no row
-- yet keeps getting the built-in defaults, exactly as before.

-- One row per tenant is no longer the rule.
DROP INDEX "agent_configs_tenant_id_key";

ALTER TABLE "agent_configs" ADD COLUMN     "default_for" TEXT,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

ALTER TABLE "call_logs" ADD COLUMN     "agent_id" TEXT;
ALTER TABLE "conversations" ADD COLUMN     "agent_id" TEXT;
ALTER TABLE "records" ADD COLUMN     "agent_id" TEXT;

-- Until now tenant_id was unique, so every existing row is its tenant's only (= default) agent.
UPDATE "agent_configs" SET "default_for" = "tenant_id";

UPDATE "conversations" c SET "agent_id" = a."id" FROM "agent_configs" a WHERE a."default_for" = c."tenant_id";
UPDATE "call_logs" l SET "agent_id" = a."id" FROM "agent_configs" a WHERE a."default_for" = l."tenant_id";
UPDATE "records" r SET "agent_id" = a."id" FROM "agent_configs" a WHERE a."default_for" = r."tenant_id";

CREATE UNIQUE INDEX "agent_configs_default_for_key" ON "agent_configs"("default_for");
CREATE INDEX "agent_configs_tenant_id_idx" ON "agent_configs"("tenant_id");
CREATE INDEX "call_logs_agent_id_created_at_idx" ON "call_logs"("agent_id", "created_at");
CREATE INDEX "conversations_agent_id_idx" ON "conversations"("agent_id");
CREATE INDEX "records_agent_id_created_at_idx" ON "records"("agent_id", "created_at");
