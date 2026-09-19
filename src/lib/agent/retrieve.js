import { prisma } from "@/lib/db";
import { embedText } from "./gemini";

/**
 * Embed a query and find the tenant's most relevant knowledge_chunks by
 * cosine distance. Step 2 of the RAG pipeline.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.query - the user's raw question/message text
 * @param {number} [args.topK]
 */
export async function retrieveRelevantChunks({ tenantId, query, topK = 5 }) {
  const queryEmbedding = await embedText(query);
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  // pgvector's <=> operator is cosine distance (lower = more similar).
  // $queryRaw because Prisma Client can't express a vector operator itself.
  return prisma.$queryRaw`
    SELECT id, source, content, embedding <=> ${vectorLiteral}::vector AS distance
    FROM ai_engine.knowledge_chunks
    WHERE tenant_id = ${tenantId}
    ORDER BY distance ASC
    LIMIT ${topK}
  `;
}

// Once a tenant has a meaningful number of chunks, add a similarity index via
// a raw SQL migration, e.g.:
//   CREATE INDEX knowledge_chunks_embedding_idx ON ai_engine.knowledge_chunks
//   USING hnsw (embedding vector_cosine_ops);
// Skip this until there's enough data for a sequential scan to actually hurt.
