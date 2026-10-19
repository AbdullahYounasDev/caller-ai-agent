-- Two languages (English and Urdu only) and the details the agent collects (CLAUDE.md §6.25).
--
-- Hand-written from `prisma migrate diff`, with its first statement REMOVED: the diff opens with
-- `DROP INDEX "knowledge_chunks_embedding_idx"` — the HNSW index Prisma cannot see (§6.1).
-- This migration drops nothing.
--
-- PART 1 — DATA: Italian, Arabic and "auto" are gone from the product. Rows written under them
-- are moved to the nearest thing that still exists, so nothing stored can name a language the
-- code no longer knows:
--   * a reply language that is not en/ur (it, auto, ar…) becomes English — the default;
--   * the same for the dashboard language;
--   * a chosen Italian voice is dropped from the per-language voice map;
--   * a conversation labelled with a removed language is labelled English;
--   * chunks of an Italian document (search_config 'italian') are indexed as 'english' — the
--     generated content_tsv column is recomputed by Postgres. No embeddings change, so
--     nothing is re-embedded and MAX_DISTANCE is untouched.
UPDATE "agent_configs" SET "reply_language" = 'en' WHERE "reply_language" NOT IN ('en', 'ur');
UPDATE "agent_configs" SET "ui_locale" = 'en' WHERE "ui_locale" NOT IN ('en', 'ur');
UPDATE "agent_configs" SET "voices" = "voices" - 'it' WHERE jsonb_exists("voices", 'it');
UPDATE "conversations" SET "locale" = 'en' WHERE "locale" NOT IN ('en', 'ur');
UPDATE "knowledge_chunks" SET "search_config" = 'english'::regconfig WHERE "search_config" = 'italian'::regconfig;

-- PART 2 — SCHEMA: the collection settings, the per-conversation draft, and the two stand-in
-- tables for customers and their requests (see the warning above `model Customer`).
-- AlterTable
ALTER TABLE "agent_configs" ADD COLUMN     "collect" JSONB,
ADD COLUMN     "collect_version" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "reply_language" SET DEFAULT 'en';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "collect_draft" JSONB;

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "conversation_id" TEXT,
    "customer_id" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'chat',
    "language" TEXT NOT NULL DEFAULT 'en',
    "data" JSONB NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "scheduled_local" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "config_version" INTEGER NOT NULL DEFAULT 0,
    "submission_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_tenant_id_idx" ON "customers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_phone_key" ON "customers"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "records_tenant_id_status_created_at_idx" ON "records"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "records_tenant_id_type_idx" ON "records"("tenant_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "records_tenant_id_submission_key_key" ON "records"("tenant_id", "submission_key");

-- CreateIndex
CREATE UNIQUE INDEX "records_tenant_id_reference_key" ON "records"("tenant_id", "reference");

-- AddForeignKey
ALTER TABLE "records" ADD CONSTRAINT "records_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

