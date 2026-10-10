-- AlterTable
-- Which embedding scheme (src/lib/agent/embed-scheme.js) a document's chunks were
-- embedded under. Existing rows get 0, the original scheme, so nothing is stale
-- until EMBEDDING_SCHEME_VERSION is bumped.
--
-- Hand-written, not generated: `prisma migrate diff` also emits a DROP INDEX for the
-- HNSW index Prisma cannot see (CLAUDE.md §6.1). This migration deliberately does not.
ALTER TABLE "knowledge_sources" ADD COLUMN     "embedding_scheme" INTEGER NOT NULL DEFAULT 0;
