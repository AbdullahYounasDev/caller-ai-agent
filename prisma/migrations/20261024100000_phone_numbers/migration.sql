-- Phone numbers and which agent each one rings (CLAUDE.md §6.29). A STAND-IN for the backend's
-- number table (docs/handoff-to-backend.md B11), read by the engine only through
-- tenant/registry.js resolveDialledNumber(). call_logs gains the number a call came in on.
--
-- Hand-written from `prisma migrate diff`, with the `DROP INDEX "knowledge_chunks_embedding_idx"`
-- line REMOVED — the HNSW index Prisma cannot see (§6.1). Changes no existing row.

ALTER TABLE "call_logs" ADD COLUMN     "phone_number_id" TEXT;

CREATE TABLE "phone_numbers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "active_e164" TEXT,
    "agent_id" TEXT,
    "label" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "kind" TEXT NOT NULL DEFAULT 'purchased',
    "provider" TEXT NOT NULL DEFAULT 'twilio',
    "provider_sid" TEXT,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "phone_numbers_active_e164_key" ON "phone_numbers"("active_e164");
CREATE INDEX "phone_numbers_tenant_id_idx" ON "phone_numbers"("tenant_id");
CREATE INDEX "phone_numbers_agent_id_idx" ON "phone_numbers"("agent_id");
CREATE INDEX "phone_numbers_e164_idx" ON "phone_numbers"("e164");
CREATE INDEX "call_logs_phone_number_id_created_at_idx" ON "call_logs"("phone_number_id", "created_at");

ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
