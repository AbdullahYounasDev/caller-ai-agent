import { chunkDocument } from "./chunk";
import { EMBED_DOCUMENT_TITLE, STRUCTURED_TABLES } from "./embed-scheme";
import { csvToDocument } from "./tables";

/**
 * The text-to-chunks step, shared by ingest, retry, re-embed and the audit scripts so every
 * one of them embeds a document the same way (§6.2). The title only reaches `embedText`, and
 * only while EMBED_DOCUMENT_TITLE says so.
 *
 * CSV is converted HERE, from the STORED content, and not in extractText, on purpose: stored
 * `content` stays the file as the business wrote it, and `npm run reembed` re-chunks from stored
 * content — so converting at this point is what lets the bundled re-embed repair CSV documents
 * that are already in the knowledge base. (DOCX cannot work that way: its stored text has already
 * lost the table structure, so it is converted at extraction and needs a re-upload — §6.23.)
 *
 * @param {object} doc
 * @param {string} doc.text      stored content
 * @param {string} [doc.title]
 * @param {string|null} [doc.fileName] decides whether the text is a CSV
 * @param {object} [overrides]   for tests and audits only; the app passes none
 * @param {boolean} [overrides.structuredTables]
 * @param {boolean} [overrides.lossless]
 */
export function chunksForDocument({ text, title, fileName }, { structuredTables = STRUCTURED_TABLES, lossless } = {}) {
  let body = text;
  if (structuredTables && /\.csv$/i.test(String(fileName ?? ""))) {
    body = csvToDocument(text, { name: fileName || title }) ?? text; // not table-like: keep the raw text
  }
  return chunkDocument(body, {
    title: EMBED_DOCUMENT_TITLE ? title : undefined,
    ...(lossless === undefined ? {} : { lossless }),
  });
}
