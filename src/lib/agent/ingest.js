import { prisma } from "@/lib/db";
import { embedText } from "./llm";
import { chunkDocument } from "./chunk";
import { deleteOriginalFile } from "./storage";
import { JobCancelledError } from "./jobs";

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
const MAX_CHUNKS_PER_DOCUMENT = 400;

/**
 * Create a document, or replace it if one with the same title already exists.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.title      what the business calls it; unique per tenant
 * @param {string} args.text       the extracted plain text
 * @param {"text"|"file"|"url"} [args.kind]
 * @param {{fileName?: string, mimeType?: string, byteSize?: number}} [args.file]
 * @returns {Promise<{id: string, title: string, chunkCount: number, replaced: boolean}>}
 */
export async function ingestDocument({
  tenantId,
  title,
  text,
  kind = "text",
  file = {},
  // Optional, supplied when running inside a background job. Embedding is the
  // long part — one network round trip per chunk — so it is reported per chunk
  // rather than as a single opaque step.
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

  await onSource?.(source.id);

  try {
    await onProgress?.("chunking", 0, 1);
    const chunks = chunkDocument(text);
    if (!chunks.length) throw new Error("Document produced no chunks");
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
      throw new Error(
        `Document is too large: ${chunks.length} sections, limit ${MAX_CHUNKS_PER_DOCUMENT}`
      );
    }

    // Embed BEFORE touching the old chunks. If the model is down or out of
    // quota, the previous version of the document keeps answering questions
    // instead of the business being left with nothing.
    const embedded = [];
    for (const chunk of chunks) {
      embedded.push({ ...chunk, vector: await embedText(chunk.embedText) });
      await onProgress?.("embedding", embedded.length, chunks.length);
    }

    await onProgress?.("saving", 1, 1);
    await prisma.$transaction(async (tx) => {
      // The replace. Same transaction as the insert, so retrieval never sees a
      // document that is half old and half new.
      await tx.knowledgeChunk.deleteMany({ where: { sourceId: source.id } });

      for (let i = 0; i < embedded.length; i++) {
        const chunk = embedded[i];
        // Raw SQL for the vector column — Prisma Client has no vector type.
        await tx.$executeRaw`
          INSERT INTO ai_engine.knowledge_chunks
            (id, tenant_id, source_id, source_title, heading, ordinal, content, embedding, created_at)
          VALUES (
            gen_random_uuid(), ${tenantId}, ${source.id}, ${cleanTitle},
            ${chunk.heading || null}, ${i}, ${chunk.content},
            ${`[${chunk.vector.join(",")}]`}::vector, now()
          )
        `;
      }

      await tx.knowledgeSource.update({
        where: { id: source.id },
        data: { status: "ready", chunkCount: embedded.length, error: null },
      });
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
 * is reading yet.
 */
export async function listSources(tenantId) {
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
  const source = await prisma.knowledgeSource.findUnique({ where: { id } });
  if (!source || source.tenantId !== tenantId) return null;
  return source;
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
