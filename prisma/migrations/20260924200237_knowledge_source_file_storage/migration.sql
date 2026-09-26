-- AlterTable
ALTER TABLE "ingest_jobs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "knowledge_sources" ADD COLUMN     "file_public_id" TEXT,
ADD COLUMN     "file_url" TEXT,
ALTER COLUMN "updated_at" DROP DEFAULT;
