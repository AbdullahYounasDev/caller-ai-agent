import { prisma } from "@/lib/db";
import { embedText } from "./gemini";

/**
 * Chunk a tenant document, embed each chunk with Gemini, store it in
 * knowledge_chunks. This is step 1 of the RAG pipeline — nothing in
 * retrieve.js/respond.js returns anything useful until documents have been
 * ingested for a tenant.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.source - filename/URL/identifier this text came from
 * @param {string} args.text   - raw document text, already extracted
 */
export async function ingestDocument({ tenantId, source, text }) {
  const chunks = chunkText(text);
  let inserted = 0;

  for (const chunk of chunks) {
    const embedding = await embedText(chunk);
    // Prisma Client has no vector type (see schema.prisma's Unsupported()
    // note), so the insert goes through raw SQL. pgvector accepts a vector
    // as a string like "[0.1,0.2,...]" cast with ::vector.
    const vectorLiteral = `[${embedding.join(",")}]`;

    await prisma.$executeRaw`
      INSERT INTO ai_engine.knowledge_chunks (id, tenant_id, source, content, embedding, created_at)
      VALUES (gen_random_uuid(), ${tenantId}, ${source}, ${chunk}, ${vectorLiteral}::vector, now())
    `;
    inserted++;
  }

  return { chunksInserted: inserted };
}

// Fixed-size word-window chunking with overlap. Simple on purpose — good
// enough to get the pipeline working end-to-end; revisit only if retrieval
// quality actually suffers (e.g. move to heading-aware or semantic chunking).
function chunkText(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunkSize = 500;
  const overlap = 50;
  const chunks = [];

  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (chunk) chunks.push(chunk);
    if (i + chunkSize >= words.length) break;
  }

  return chunks;
}
