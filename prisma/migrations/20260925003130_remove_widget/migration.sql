-- REMOVE THE EMBEDDABLE WIDGET.
--
-- Product direction changed: the platform is a CALLING system. The browser
-- widget — public keys, origin allowlists, per-tenant themes — was built for a
-- channel we are no longer shipping, and leaving its tables behind would mean
-- every future reader has to work out which half of the schema is live.
--
-- What survives is the RAG engine underneath it, which is channel-agnostic and
-- is exactly what telephony will sit on.
--
-- NOTE: the generated diff also wanted to DROP knowledge_chunks_embedding_idx,
-- because Prisma 6 cannot represent an HNSW index and therefore believes it
-- should not exist. That line was removed deliberately — see the warning on
-- KnowledgeChunk in schema.prisma, and `npm run db:check`.

-- Public keys for embedding the widget on customer websites.
DROP TABLE IF EXISTS "widget_keys";

-- Per-tenant widget theme (logo, colour, launcher position, greeting).
ALTER TABLE "agent_configs" DROP COLUMN IF EXISTS "widget";

-- Channel vocabulary: "widget" and "whatsapp" are no longer channels this
-- system has. Existing rows are relabelled rather than deleted so the
-- transcripts stay readable.
UPDATE "conversations" SET channel = 'chat' WHERE channel IN ('widget', 'whatsapp');
UPDATE "messages"      SET channel = 'chat' WHERE channel IN ('widget', 'whatsapp');
