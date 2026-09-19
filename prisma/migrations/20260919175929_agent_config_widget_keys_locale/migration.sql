-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en';

-- CreateTable
CREATE TABLE "agent_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT 'professional',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "hours" JSONB,
    "escalation" JSONB,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "widget" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_keys" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "allowed_origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_configs_tenant_id_key" ON "agent_configs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "widget_keys_public_key_key" ON "widget_keys"("public_key");

-- CreateIndex
CREATE INDEX "widget_keys_tenant_id_idx" ON "widget_keys"("tenant_id");
