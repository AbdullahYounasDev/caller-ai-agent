import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { embedTexts } from "./llm";
import { chunksForDocument } from "./prepare";
import { detectSearchConfig } from "./language";
import { EMBEDDING_SCHEME_VERSION } from "./embed-scheme";
import { deleteOriginalFile } from "./storage";
import { JobCancelledError } from "./jobs";
import { agentsBySource, setSourceAgents } from "./knowledge-access";

/**
 * KNOWLEDGE INGESTION — create, replace, rename and delete a business's documents.
 *
 * THE RULE THAT DEFINES THIS FILE: ingesting a document that already exists
 * REPLACES it. It does not add to it.
 *
 * Before, ingest was insert-only. A business that corrected a price and
 * re-uploaded its list ended up with both versions embedded, competing in
 * retrieval — and the agent would sometimes quote the price they had just
 * fixed. There was no way to undo it short of editing the database. Every
 * write below therefore deletes the document's old chunks in the same
 * transaction that inserts the new ones.
 */

/** Chunks are embedded one at a time; this caps how many a single document may
 *  produce, so one enormous upload cannot spend a tenant's whole daily model
 *  quota in a single request. */
export const MAX_CHUNKS_PER_DOCUMENT = 400;

/** Chunks per embedding request. This buys LATENCY, not quota — the free tier
 *  counts per text (§6.20) — and it sets how often a cancel can take effect
 *  (once per batch, checked BEFORE the request is spent). 16 keeps a request
 *  small enough to retry cheaply while cutting a 100-chunk document from 100
 *  round trips to 7. */
const EMBED_BATCH_SIZE = 16;

/** Identity of "the text we sent to the embedding model" — see embed_hash in the schema. */
function hashEmbedText(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The vectors a replace may keep instead of paying for again (§6.21).
 *
 * Returns hash → the vector as pgvector's own text ("[0.1,0.2,…]"), which is written
 * straight back without being parsed into JS numbers, so a reused vector is
 * bit-identical to the stored one by construction.
 *
 * A vector is only ever reused when BOTH hold, and both are enforced in this one
 * statement rather than checked beforehand:
 *   - the chunk's embed_hash equals the hash of the new chunk's embedText (same exact
 *     text, same model — §6.2), and
 *   - the document is on the CURRENT embedding scheme right now. A vector from another
 *     scheme version lives in a different space (a taskType rescales distances, a title
 *     prefix moves every vector), so it must never be mixed in. Joining the source row
 *     reads the version in the same snapshot as the vectors — a re-embed finishing
 *     between two separate reads cannot slip a stale one through.
 * Rows with a NULL hash (everything written before the column existed) never match.
 *
 * Best-effort: reuse is an optimisation. If this read fails the document is simply
 * embedded in full, exactly as before.
 *
 * @param {string} sourceId
 * @param {string[]} hashes
 * @returns {Promise<Map<string, string>>}
 */
async function loadReusableVectors(sourceId, hashes) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT c.embed_hash AS hash, c.embedding::text AS vec
      FROM ai_engine.knowledge_chunks c
      JOIN ai_engine.knowledge_sources s ON s.id = c.source_id
      WHERE c.source_id = ${sourceId}
        AND s.embedding_scheme = ${EMBEDDING_SCHEME_VERSION}
        AND c.embed_hash = ANY(${hashes}::text[])
    `;
    return new Map(rows.map((r) => [r.hash, r.vec]));
  } catch (err) {
    console.warn("[ingest] could not read stored vectors for reuse, embedding everything:", err?.message ?? err);
    return new Map();
  }
}

/**
 * Embed chunks in batches, in order, reporting progress in CHUNK units — skipping every
 * chunk whose vector the caller already has (`reusable`, hash → vector text).
 *
 * Only DISTINCT texts that are not reusable are sent. Two chunks with identical
 * embedText (a boilerplate paragraph repeated under the same heading) are one text to
 * the model and one unit of quota, not two.
 *
 * `onProgress` doubles as the cooperative-cancellation checkpoint (§6.14 —
 * JobContext.report throws JobCancelledError once a cancel is recorded), so it
 * is called BEFORE every batch request: a cancelled job never spends another
 * batch's quota. It is per batch rather than per chunk because the count it
 * writes is a database row update — sixteen of them in a burst after the
 * response would cost more time than the batching saved. A document with nothing to
 * embed has no batches; the closing call below is then its only checkpoint, and it
 * still runs before anything is swapped.
 *
 * Nothing is written anywhere here. Callers embed FIRST and swap chunks in
 * afterwards, in one transaction (§6.10).
 *
 * @returns {Promise<{embedded: Array, reusedChunks: number, embeddedTexts: number}>}
 *   each embedded chunk carries `embedHash` and either `vector` (fresh, number[]) or
 *   `vectorText` (reused, pgvector text).
 */
async function embedChunks(chunks, onProgress, reusable = new Map()) {
  const embedded = chunks.map((c) => {
    const embedHash = hashEmbedText(c.embedText);
    return { ...c, embedHash, vectorText: reusable.get(embedHash) ?? null };
  });
  const reusedChunks = embedded.filter((c) => c.vectorText).length;

  // hash → indices still needing a vector, in first-seen order.
  const pending = new Map();
  embedded.forEach((c, i) => {
    if (c.vectorText) return;
    if (!pending.has(c.embedHash)) pending.set(c.embedHash, []);
    pending.get(c.embedHash).push(i);
  });
  const groups = [...pending.values()];

  let done = reusedChunks;
  for (let i = 0; i < groups.length; i += EMBED_BATCH_SIZE) {
    await onProgress?.("embedding", done, chunks.length);
    const batch = groups.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedTexts(
      batch.map((indices) => embedded[indices[0]].embedText),
      { role: "document" }
    );
    batch.forEach((indices, j) => {
      for (const idx of indices) embedded[idx].vector = vectors[j];
      done += indices.length;
    });
  }
  await onProgress?.("embedding", done, chunks.length);
  return { embedded, reusedChunks, embeddedTexts: groups.length };
}

/**
 * The replace itself: delete a document's old chunks and insert the new ones.
 * Always called inside the caller's transaction, so retrieval never sees a
 * document that is half old and half new.
 */
async function writeChunks(tx, { tenantId, sourceId, title, embedded, searchConfig }) {
  await tx.knowledgeChunk.deleteMany({ where: { sourceId } });

  for (let i = 0; i < embedded.length; i++) {
    const chunk = embedded[i];
    // Raw SQL for the vector column — Prisma Client has no vector type.
    await tx.$executeRaw`
      INSERT INTO ai_engine.knowledge_chunks
        (id, tenant_id, source_id, source_title, heading, ordinal, content, embedding, embed_hash, search_config, created_at)
      VALUES (
        gen_random_uuid(), ${tenantId}, ${sourceId}, ${title},
        ${chunk.heading || null}, ${i}, ${chunk.content},
        ${chunk.vectorText ?? `[${chunk.vector.join(",")}]`}::vector, ${chunk.embedHash}, ${searchConfig}::regconfig, now()
      )
    `;
  }
}

/** The text-to-chunks step, shared by ingest, retry and re-embed so all of them always embed
 *  the same way. Lives in prepare.js (title prefix, CSV conversion — embed-scheme.js); the file
 *  name is what tells it a document is a CSV. */
function chunksFor(text, title, fileName) {
  return chunksForDocument({ text, title, fileName });
}

/**
 * Create a document, or replace it if one with the same title already exists.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.title      what the business calls it; unique per tenant
 * @param {string} args.text       the extracted plain text
 * @param {"text"|"file"|"url"} [args.kind]
 * @param {{fileName?: string, mimeType?: string, byteSize?: number}} [args.file]
 * @param {string[]|null} [args.agents] which agents may answer from it (§6.28): null = shared
 *   with all, a list = only those, OMITTED = leave as it is (a new document is shared). The
 *   caller has already checked the ids belong to this tenant (knowledge-access.js).
 * @returns {Promise<{id: string, title: string, chunkCount: number, replaced: boolean}>}
 */
export async function ingestDocument({
  tenantId,
  title,
  text,
  kind = "text",
  file = {},
  agents,
  // Optional, supplied when running inside a background job. Embedding is the
  // long part — one network round trip per BATCH of chunks — so it is reported
  // as it goes (in chunk units) rather than as a single opaque step.
  onProgress,
  onSource,
}) {
  if (!tenantId) throw new Error("ingestDocument requires a tenantId");
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) throw new Error("ingestDocument requires a title");
  if (!String(text ?? "").trim()) throw new Error("ingestDocument requires non-empty text");

  // The FULL row, not just its id — a replace cancelled mid-flight needs every
  // field to put the document back exactly as it was, not just know it existed.
  const existing = await prisma.knowledgeSource.findUnique({
    where: { tenantId_title: { tenantId, title: cleanTitle } },
  });

  // The row is written BEFORE embedding, marked "processing". Embedding a long
  // document takes many seconds, and a business watching the list should see
  // the document appear and say what it is doing rather than nothing at all
  // until it finishes. It also means a crash mid-embed leaves a visible,
  // explicable record instead of silence.
  const source = await prisma.knowledgeSource.upsert({
    where: { tenantId_title: { tenantId, title: cleanTitle } },
    create: {
      tenantId,
      title: cleanTitle,
      kind,
      content: text,
      fileName: file.fileName ?? null,
      mimeType: file.mimeType ?? null,
      byteSize: file.byteSize ?? null,
      fileUrl: file.fileUrl ?? null,
      filePublicId: file.filePublicId ?? null,
      status: "processing",
      chunkCount: 0,
    },
    update: {
      kind,
      content: text,
      fileName: file.fileName ?? null,
      mimeType: file.mimeType ?? null,
      byteSize: file.byteSize ?? null,
      fileUrl: file.fileUrl ?? null,
      filePublicId: file.filePublicId ?? null,
      status: "processing",
      error: null,
    },
  });

  // A NEW document's availability is set now, before any chunk exists: it is never searchable
  // by an agent it is not meant for, not even for a moment. A REPLACE keeps its old chunks
  // answering under the old availability until the swap below, which changes both at once.
  if (!existing && agents !== undefined) {
    await setSourceAgents(prisma, { tenantId, sourceId: source.id, agentIds: agents });
  }

  await onSource?.(source.id);

  try {
    await onProgress?.("chunking", 0, 1);
    const chunks = chunksFor(text, cleanTitle, file.fileName);
    if (!chunks.length) throw new Error("Document produced no chunks");
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
      throw new Error(
        `Document is too large: ${chunks.length} sections, limit ${MAX_CHUNKS_PER_DOCUMENT}`
      );
    }

    // Embed BEFORE touching the old chunks. If the model is down or out of
    // quota, the previous version of the document keeps answering questions
    // instead of the business being left with nothing.
    // INCREMENTAL: a chunk whose exact embedText is already stored under the current
    // scheme keeps its vector (§6.21). A re-upload of an unchanged file, a retry, or an
    // edit that touched one paragraph then pays only for what actually changed. The old
    // chunks are only READ here; nothing is deleted until the swap below.
    const hashes = [...new Set(chunks.map((c) => hashEmbedText(c.embedText)))];
    const reusable =
      existing && existing.embeddingScheme === EMBEDDING_SCHEME_VERSION
        ? await loadReusableVectors(source.id, hashes)
        : new Map();
    const { embedded, reusedChunks, embeddedTexts } = await embedChunks(chunks, onProgress, reusable);

    await onProgress?.("saving", 1, 1);
    await prisma.$transaction(async (tx) => {
      // The keyword index's language is a property of the DOCUMENT (language.js).
      await writeChunks(tx, {
        tenantId,
        sourceId: source.id,
        title: cleanTitle,
        embedded,
        searchConfig: detectSearchConfig(text),
      });

      await tx.knowledgeSource.update({
        where: { id: source.id },
        data: {
          status: "ready",
          chunkCount: embedded.length,
          error: null,
          embeddingScheme: EMBEDDING_SCHEME_VERSION,
        },
      });

      // Same transaction as the new chunks: no moment where the new text answers under the old
      // availability or the reverse.
      if (existing && agents !== undefined) {
        await setSourceAgents(tx, { tenantId, sourceId: source.id, agentIds: agents });
      }
    });

    // Only NOW — the new version is fully committed — is the OLD original file
    // (if any) truly unreferenced. Deleting it any earlier (e.g. right after
    // the upsert) would risk a failed or cancelled replace leaving the row
    // with no original file at all, for either version.
    if (existing?.filePublicId && existing.filePublicId !== (file.filePublicId ?? null)) {
      await deleteOriginalFile(existing.filePublicId);
    }

    return {
      id: source.id,
      title: cleanTitle,
      chunkCount: embedded.length,
      replaced: Boolean(existing),
      reusedChunks,
      embeddedTexts,
    };
  } catch (err) {
    // THIS CATCH MUST NEVER LEAVE THE ROW HALF-CHANGED. Whatever failed —
    // a genuine embedding/chunking error OR a user cancellation — the upsert
    // above has already overwritten the row's content/metadata with the NEW,
    // not-yet-embedded attempt, while the OLD chunks are still untouched
    // (deleteMany only ever runs after every chunk embeds successfully). Left
    // alone, that means the document a business reads back or edits shows the
    // new text while the agent keeps answering from the old one — a business
    // corrects a price, the save appears to go through, and the agent keeps
    // quoting the wrong number with no visible sign anything is wrong.
    if (existing) {
      // A REPLACE failed or was cancelled mid-flight. The old chunks are
      // still complete and still fully answering questions, so the honest
      // outcome is to put the row back exactly as it was — not leave it
      // pointing at content nothing backs. The ATTEMPT's failure is recorded
      // on the ingest job row instead (lib/agent/jobs.js already does this),
      // which is where "why did my last upload fail" belongs; the document
      // row's job is only to describe what the agent currently knows.
      await prisma.knowledgeSource
        .update({
          where: { id: source.id },
          data: {
            kind: existing.kind,
            content: existing.content,
            fileName: existing.fileName,
            mimeType: existing.mimeType,
            byteSize: existing.byteSize,
            fileUrl: existing.fileUrl,
            filePublicId: existing.filePublicId,
            status: existing.status,
            error: existing.error,
          },
        })
        .catch(() => {});
      // The NEW file this attempt uploaded (if any) is now unreferenced —
      // the row points at the OLD one again.
      if (file.filePublicId && file.filePublicId !== existing.filePublicId) {
        await deleteOriginalFile(file.filePublicId);
      }
    } else if (err instanceof JobCancelledError) {
      // A brand new document, cancelled — nothing existed before this job, so
      // cancelling means removing exactly what it created: the row (no
      // chunks were ever inserted, same reasoning as above) and its
      // Cloudinary original, if any. Same outcome as an ordinary delete.
      await prisma.knowledgeSource.delete({ where: { id: source.id } }).catch(() => {});
      if (file.filePublicId) await deleteOriginalFile(file.filePublicId);
    } else {
      // A brand new document, ordinary failure — there is no old version to
      // fall back to, so the honest record IS a visible failed row: a
      // business needs to see "this one failed, and why" in the list, not an
      // error toast that vanishes or a document that silently never appears.
      await prisma.knowledgeSource
        .update({
          where: { id: source.id },
          data: { status: "failed", error: String(err?.message ?? err).slice(0, 500) },
        })
        .catch(() => {});
    }

    throw err;
  }
}

/**
 * List a tenant's documents. Never returns `content` — the list screen shows
 * dozens of rows and the bodies would be megabytes of payload for text nobody
 * is reading yet. Each row carries `agents`: null = shared with every agent, else the
 * agents it is restricted to (§6.28).
 */
export async function listSources(tenantId) {
  const [rows, restricted] = await Promise.all([listSourceRows(tenantId), agentsBySource(tenantId)]);
  return rows.map((row) => ({ ...row, agents: restricted.get(row.id) ?? null }));
}

function listSourceRows(tenantId) {
  return prisma.knowledgeSource.findMany({
    where: { tenantId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      kind: true,
      fileName: true,
      mimeType: true,
      byteSize: true,
      chunkCount: true,
      status: true,
      error: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * One document including its text, for viewing and editing.
 * Scoped by tenantId as well as id — never let one tenant read another's
 * document by guessing a uuid.
 */
export async function getSource({ tenantId, id }) {
  const source = await prisma.knowledgeSource.findUnique({
    where: { id },
    include: { agents: { select: { agentId: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!source || source.tenantId !== tenantId) return null;
  const { agents, ...rest } = source;
  return { ...rest, agents: agents.length ? agents.map((a) => a.agentId) : null };
}

/**
 * Change which agents may answer from a document — and nothing else: no re-embed, the chunks
 * are the same text (§6.28). Takes effect on the next turn of every conversation.
 *
 * @param {{tenantId: string, id: string, agents: string[]|null}} args already validated
 * @returns {Promise<object|null>} the document as getSource returns it, or null if not this tenant's
 */
export async function setDocumentAgents({ tenantId, id, agents }) {
  const source = await getSource({ tenantId, id });
  if (!source) return null;
  await prisma.$transaction((tx) => setSourceAgents(tx, { tenantId, sourceId: id, agentIds: agents }));
  return getSource({ tenantId, id });
}

/**
 * Rename a document.
 *
 * `sourceTitle` is denormalised onto every chunk so retrieval can cite a source
 * without a join, which means a rename has to rewrite them — otherwise the
 * agent keeps citing the old name after the business has changed it.
 */
export async function renameSource({ tenantId, id, title }) {
  const source = await getSource({ tenantId, id });
  if (!source) return null;

  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) throw new Error("A title is required");

  const clash = await prisma.knowledgeSource.findUnique({
    where: { tenantId_title: { tenantId, title: cleanTitle } },
    select: { id: true },
  });
  if (clash && clash.id !== id) throw new Error("A document with that name already exists");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.knowledgeSource.update({
      where: { id },
      data: { title: cleanTitle },
    });
    await tx.knowledgeChunk.updateMany({
      where: { sourceId: id },
      data: { sourceTitle: cleanTitle },
    });
    return updated;
  });
}

/**
 * Delete a document and everything derived from it.
 *
 * The chunks go via the schema's `onDelete: Cascade`, in the same statement —
 * there is no window where the document is gone from the list but its content
 * is still answering questions. That row delete is the part that MUST succeed
 * for the document to be considered gone, so it happens first; the Cloudinary
 * original (if any) is cleaned up after, best-effort, since it is storage
 * hygiene and never something retrieval depends on.
 */
export async function deleteSource({ tenantId, id }) {
  const source = await getSource({ tenantId, id });
  if (!source) return null;
  await prisma.knowledgeSource.delete({ where: { id } });
  if (source.filePublicId) await deleteOriginalFile(source.filePublicId);
  return { id, title: source.title };
}

/**
 * Retry embedding a document that previously failed — a quota or network
 * error, most commonly (see humanizeError in the console). Everything the
 * pipeline needs is already sitting on the row: `content` was saved BEFORE
 * embedding was ever attempted (see the upsert in ingestDocument), and the
 * Cloudinary original, if any, was never touched by the failure. So a retry
 * never re-reads the original upload or hits Cloudinary again — it just
 * re-runs chunking + embedding against what is already stored, through the
 * exact same ingestDocument used for every other ingest, which is what gives
 * it the same rollback-on-failure and cancellation behaviour for free.
 *
 * Passing the row's OWN fileUrl/filePublicId back in as `file` matters: if
 * this were omitted, ingestDocument's upsert would write `fileUrl: null`,
 * silently orphaning the Cloudinary asset a retry had no reason to touch.
 */
export async function retrySource({ tenantId, id, onProgress, onSource }) {
  const source = await getSource({ tenantId, id });
  if (!source) return null;
  if (source.status !== "failed") {
    throw new Error("Only a failed document can be retried");
  }

  return ingestDocument({
    tenantId,
    title: source.title,
    text: source.content,
    kind: source.kind,
    file: {
      fileName: source.fileName,
      mimeType: source.mimeType,
      byteSize: source.byteSize,
      fileUrl: source.fileUrl,
      filePublicId: source.filePublicId,
    },
    onProgress,
    onSource,
  });
}

/**
 * Re-embed ONE existing document under the current embedding scheme, from its
 * stored `content` (§6.10 — content is the original text, so no re-upload and no
 * Cloudinary). Used by `npm run reembed`.
 *
 * Same guarantees as an ordinary replace: it embeds EVERYTHING before touching
 * a single old chunk, then swaps in one transaction — a quota stop or a crash
 * mid-document leaves the old chunks fully in place, never a document with none.
 * Unlike ingestDocument it never marks the row "processing": nothing about the
 * document changed, and the agent keeps answering from the old chunks until the
 * swap.
 *
 * ⚠️ It must NOT touch `updated_at`. That date is the recency signal the
 * conflict rule uses to decide which of two disagreeing documents wins (§6.10);
 * a re-embed is not an edit, and bumping it would quietly promote every
 * re-embedded document over a newer one it contradicts. So the final write is
 * raw SQL — Prisma's `@updatedAt` only fires through the client.
 *
 * Optimistic: if the document is edited or replaced while this embeds, its own
 * ingest already used the current scheme, so the swap is skipped.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.id
 * @param {(stage: string, done: number, total: number) => Promise<void>} [args.onProgress]
 * @returns {Promise<{status: "reembedded", chunks: number}|{status: "skipped"|"superseded", reason: string}>}
 */
export async function reembedSource({ tenantId, id, onProgress }) {
  const source = await getSource({ tenantId, id });
  if (!source) return { status: "skipped", reason: "document no longer exists" };
  if (source.status !== "ready") return { status: "skipped", reason: `status is "${source.status}"` };
  if (source.embeddingScheme >= EMBEDDING_SCHEME_VERSION) {
    return { status: "skipped", reason: "already on the current scheme" };
  }

  const chunks = chunksFor(source.content, source.title, source.fileName);
  if (!chunks.length) return { status: "skipped", reason: "content produces no chunks" };
  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    return { status: "skipped", reason: `${chunks.length} chunks, over the ${MAX_CHUNKS_PER_DOCUMENT} limit` };
  }

  // No `reusable` here, deliberately: this runs only for a document BEHIND the current
  // scheme, and every one of its stored vectors is from the wrong one (§6.2).
  const { embedded } = await embedChunks(chunks, onProgress);

  return prisma.$transaction(async (tx) => {
    const fresh = await tx.knowledgeSource.findUnique({
      where: { id },
      select: { updatedAt: true, embeddingScheme: true },
    });
    if (
      !fresh ||
      fresh.updatedAt.getTime() !== source.updatedAt.getTime() ||
      fresh.embeddingScheme >= EMBEDDING_SCHEME_VERSION
    ) {
      return { status: "superseded", reason: "edited or re-ingested while it was being embedded" };
    }
    await writeChunks(tx, {
      tenantId,
      sourceId: id,
      title: source.title,
      embedded,
      searchConfig: detectSearchConfig(source.content),
    });
    await tx.$executeRaw`
      UPDATE ai_engine.knowledge_sources
      SET chunk_count = ${embedded.length}, embedding_scheme = ${EMBEDDING_SCHEME_VERSION}
      WHERE id = ${id}
    `;
    return { status: "reembedded", chunks: embedded.length };
  });
}
