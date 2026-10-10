/**
 * WHAT GETS EMBEDDED — every decision that changes a stored vector, in one file.
 *
 * Changing ANY value below changes the vectors a document would get. Existing
 * rows keep their old vectors, so a tenant ends up with chunks embedded two
 * different ways, compared against each other and against one query: not
 * nonsense (same model, same space — §6.2) but a quiet, uneven skew, and the
 * measured `MAX_DISTANCE` (§6.3) no longer describes the corpus.
 *
 * So the rule is: change a value here, BUMP `EMBEDDING_SCHEME_VERSION`, run
 * `npm run reembed`, re-run the threshold sweep, and only then trust
 * `MAX_DISTANCE` again. Each `knowledge_sources` row records the version it was
 * embedded under (`embedding_scheme`), which is what makes the re-embed
 * resumable after a quota stop and lets `npm run db:check` fail loudly while any
 * document is still on an older scheme.
 *
 * The free embedding quota is ~1000 TEXTS a day (counted per text, not per
 * request — batching does not save any, §6.20), so a re-embed is a budgeted
 * event, not something to do per idea: batch every change into one bump.
 */

/** 0 = the original scheme: heading path only, no task types. Bump on any change below. */
export const EMBEDDING_SCHEME_VERSION = 0;

/** Prefix every chunk's embedText with the document's humanised title, which also
 *  gives a heading-less file (a CSV) a breadcrumb. See chunk.js and §6.20. */
export const EMBED_DOCUMENT_TITLE = false;

/** Send Gemini `taskType` RETRIEVAL_DOCUMENT for chunks and RETRIEVAL_QUERY for
 *  questions. The `role` argument is ALWAYS passed regardless (embedText has no
 *  default — a caller that forgets which side it is on fails loudly); this only
 *  decides whether the role reaches the API. Off until measured (§6.20). */
export const USE_EMBEDDING_TASK_TYPES = false;

/**
 * Chunk WITHOUT silently dropping text. Two bugs in chunk.js lose content from
 * the stored chunks (found by tests/chunk.test.js, not by any eval):
 *
 *  1. Any section over TARGET_CHARS was split into "sentences" by a regex that
 *     only matched text ending in . ! ? or at the very end of the section. A
 *     fragment ending at a newline matched neither, so it VANISHED. A PDF section
 *     is hard-wrapped lines with no blank lines (extractPdf, §6.4) and a CSV is
 *     rows with no periods: measured on a 1.8 KB wrapped section, 38 of 39 lines
 *     were dropped; a 150-row CSV kept 1 row.
 *  2. The LAST line of a document was read as "followed by a blank line"
 *     (nothing follows it), so a short title-cased final line — "Prices Include
 *     VAT", or a CSV's last row — was classified a heading and dropped, since a
 *     heading's own text never enters a chunk body.
 *
 * Both change chunk boundaries and text, so every vector they touch changes: this
 * is a scheme change like the two above. OFF until it is adopted WITH the one
 * bundled re-embed — set true, bump EMBEDDING_SCHEME_VERSION, `npm run reembed`,
 * re-run the sweeps (§6.3). Until then the lossy behaviour is the one the stored
 * vectors were built from, and tests/chunk.test.js pins both modes.
 */
export const CHUNK_LOSSLESS = false;

/**
 * Turn tables into SELF-DESCRIBING ROWS before chunking (§6.23). A CSV was chunked as an
 * untitled blob of comma-separated text — "Pro,149,5,Unlimited" with no column names — and the
 * table in a DOCX was shredded cell by cell: mammoth emits each cell as a paragraph, the chunker
 * mistook "Lite", "Pro" and "Unlimited" for headings, and a heading with no body is dropped, so
 * "Email" and "Custom pricing" vanished from the text altogether (tests/tables.test.mjs, the audit
 * in scripts/audit-chunks.mjs). With this on:
 *   "Plan: Pro; Monthly Price EUR: 149; Stores: 5; SKUs: Unlimited; Support: Email + Phone"
 * grouped under "Columns: …" and, for a CSV, a heading made from the file name.
 *
 * Two different seams, because the two formats store different things:
 *   - CSV is converted at CHUNK time from the stored original text (prepare.js), so
 *     `npm run reembed` repairs CSV documents already in the knowledge base.
 *   - DOCX is converted at EXTRACTION time, and only the extracted text is stored — the
 *     structure is gone from every DOCX already ingested. Re-embedding cannot recover it: a DOCX
 *     containing a table has to be RE-UPLOADED after this is on (list them with the query in
 *     CLAUDE.md §6.23).
 * Changes every vector it touches, so it is a scheme change like the ones above. OFF until
 * adopted WITH the one bundled re-embed: set true, bump EMBEDDING_SCHEME_VERSION, `npm run
 * reembed`, re-upload DOCX files with tables, re-run the sweeps (§6.3).
 */
export const STRUCTURED_TABLES = false;
