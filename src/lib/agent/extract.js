import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { looksScanned } from "./ocr";
import { STRUCTURED_TABLES } from "./embed-scheme";

/**
 * Turn an uploaded file into plain text.
 *
 * WHAT IS ACCEPTED, AND WHY THE LIST IS SHORT: a knowledge base is text. PDFs,
 * Word documents, plain text, Markdown and CSV all carry text a business
 * actually wrote. Images do not — an agent cannot answer from a photograph of a
 * price list without OCR, and silently accepting a JPEG would produce a
 * document with no content that quietly answers nothing. Better to refuse it
 * with a reason the business can act on.
 *
 * Everything here runs server-side on a file a stranger's browser sent, so each
 * format is bounded and each failure is caught: a corrupt PDF must return "we
 * couldn't read this file", never take the route handler down.
 */

/** 10 MB. Generous for a policy document, small enough that one upload cannot
 *  occupy the process for minutes or blow memory while being parsed. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Accepted types, keyed by extension. Mime types are listed per extension
 * because browsers disagree — .docx arrives as the long OpenXML string from
 * Chrome and occasionally as application/octet-stream from others, and .md is
 * frequently typed as text/plain or nothing at all.
 */
export const ACCEPTED = {
  ".pdf": { label: "PDF", mimes: ["application/pdf"] },
  ".docx": {
    label: "Word document",
    mimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
    ],
  },
  ".txt": { label: "Text file", mimes: ["text/plain", ""] },
  ".md": { label: "Markdown", mimes: ["text/markdown", "text/plain", ""] },
  ".csv": { label: "CSV", mimes: ["text/csv", "text/plain", "application/vnd.ms-excel", ""] },
};

export const ACCEPTED_EXTENSIONS = Object.keys(ACCEPTED);

/** The `accept` attribute for a file input, so the picker itself filters. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(",");

/**
 * Can this document be edited as text in the dashboard?
 *
 * Only formats whose STORED CONTENT IS THE DOCUMENT: typed text, .txt, .md.
 *
 * A PDF, Word file or spreadsheet is stored as text we EXTRACTED from it, and
 * that extraction is lossy — layout, tables and formatting are gone. Letting
 * someone edit it would present our approximation as if it were their file,
 * and the next re-upload would silently throw their edits away. For those, the
 * honest operations are replace (upload again) and delete.
 *
 * @param {{kind?: string, fileName?: string|null}} source
 */
export function isEditable(source) {
  if (!source) return false;
  if (source.kind === "text") return true;
  if (source.kind === "url") return false; // a re-crawl would overwrite any edit
  return [".txt", ".md"].includes(extensionOf(source.fileName ?? ""));
}

function extensionOf(fileName) {
  const match = /(\.[a-z0-9]+)$/i.exec(String(fileName ?? "").trim());
  return match ? match[1].toLowerCase() : "";
}

/**
 * Is this file something we can read?
 *
 * Extension decides, mime only corroborates. A mime type is supplied by the
 * client and is therefore worthless as a security check on its own — but the
 * real protection here is not the check, it is that every parser below is a
 * text extractor. Nothing is executed, rendered, or written to disk.
 *
 * @returns {{ok: true, ext: string} | {ok: false, reason: string}}
 */
export function checkFile({ fileName, mimeType, byteSize }) {
  const ext = extensionOf(fileName);

  if (!ext || !ACCEPTED[ext]) {
    return {
      ok: false,
      reason: `unsupportedType:${ACCEPTED_EXTENSIONS.join(" ")}`,
    };
  }
  if (typeof byteSize === "number" && byteSize > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: "tooLarge" };
  }
  if (typeof byteSize === "number" && byteSize === 0) {
    return { ok: false, reason: "empty" };
  }

  // An image renamed to .pdf is caught by the parser failing, not here — but a
  // declared image type is worth rejecting early with a clearer message.
  if (mimeType && /^(image|video|audio)\//.test(mimeType)) {
    return { ok: false, reason: `unsupportedType:${ACCEPTED_EXTENSIONS.join(" ")}` };
  }

  return { ok: true, ext };
}

/**
 * Where pdfjs keeps the metrics for the 14 standard PDF fonts (Helvetica,
 * Times, Courier…). Documents using those fonts do not embed them, so without
 * this pdfjs cannot map their glyphs to characters — and plenty of real
 * business PDFs are exactly that. Resolved from the installed package rather
 * than hardcoded, so it survives a version bump.
 */
function standardFontDataUrl() {
  try {
    const require = createRequire(import.meta.url);
    const dir = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");

    // Only offer the path if the font pdfjs actually asks for is there. This
    // build ships .pfb files while pdfjs 6 looks for .ttf, and pointing it at a
    // directory missing what it wants produces a warning on EVERY page of
    // EVERY pdf — noise that buries the errors worth reading.
    if (!existsSync(join(dir, "LiberationSans-Regular.ttf"))) return undefined;
    return pathToFileURL(dir + "/").href;
  } catch {
    // Extraction still works for embedded fonts; only the standard ones suffer.
    return undefined;
  }
}

/**
 * PDF text extraction via pdfjs-dist.
 *
 * pdfjs is used rather than a lighter parser because it is the same engine
 * browsers use, so it copes with the real-world PDFs businesses actually have —
 * multi-column layouts, embedded fonts, generated exports — instead of only
 * the well-formed ones.
 *
 * Items are joined with awareness of line breaks: pdfjs returns positioned text
 * runs, and naively joining them with spaces turns a price table into one
 * unreadable line, which then chunks badly and retrieves worse.
 */
async function extractPdf(buffer) {
  // Imported lazily and from the legacy build: the default entry expects
  // browser globals (DOMMatrix, canvas) that do not exist in Node.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // The LOADING TASK is what owns the worker and must be destroyed — in
  // pdfjs 6 the document proxy has no destroy() of its own, and calling one
  // throws. Keeping the task in scope is what makes cleanup possible at all.
  const loadingTask = pdfjs.getDocument({
    // A COPY, not a view. pdfjs TRANSFERS the buffer it is given to its
    // internal worker, which DETACHES the original — so the second reader of
    // the same upload finds an empty husk and throws "Construct on a detached
    // ArrayBuffer". That is exactly what happens when a scanned PDF goes
    // through text extraction first and OCR second.
    data: new Uint8Array(buffer.slice(0)),
    // No workers server-side, and no eval — both would be needless risk in a
    // route handler parsing someone else's file.
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: standardFontDataUrl(),
  });
  const doc = await loadingTask.promise;

  // Collect every page's lines WITH the font height each was rendered at,
  // before deciding what counts as a heading — that decision needs the
  // WHOLE document's typical body size, not just one page's.
  const pageLines = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();

    let line = "";
    const lines = [];
    let lastY = null;
    let lineHeight = null;

    const flushLine = () => {
      const trimmed = line.trim();
      line = "";
      if (trimmed) lines.push({ text: trimmed, height: lineHeight });
    };

    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = item.transform?.[5];
      // A vertical jump means a new line. Without this every page collapses
      // into a single run-on paragraph and the chunker has nothing to work with.
      if (lastY !== null && typeof y === "number" && Math.abs(y - lastY) > 2) {
        flushLine();
      }
      line += item.str;
      if (typeof item.height === "number" && item.height > 0) lineHeight = item.height;
      if (item.hasEOL) flushLine();
      if (typeof y === "number") lastY = y;
    }
    flushLine();

    pageLines.push(lines);
    page.cleanup();
  }

  const pageCount = doc.numPages;

  // Destroy the TASK, not the document — see the note where it is created.
  // Getting this wrong throws AFTER the text has been extracted, which reads as
  // "we couldn't read that file" for a file that was read perfectly.
  await loadingTask.destroy();

  // HEADINGS, FROM FONT SIZE. pdfjs never tells us "this line is a heading",
  // but it does tell us how tall each line was rendered — and a real
  // document's headings are reliably set in a LARGER size than its own body
  // text (verified against an actual business PDF: title 22pt, every
  // numbered section heading 15pt, all body text 11pt, with no exceptions).
  // A vertical-GAP heuristic was tried first and rejected: an ordinary
  // wrapped line and a genuine section break rendered with near-identical
  // gaps in that same PDF, so gap alone could not tell them apart and mostly
  // just planted blank lines mid-sentence. Font size does not have that
  // problem — it is closer to what a heading structurally IS. Lines from
  // each larger-than-body size TIER are promoted to a markdown heading
  // (largest tier "#", next "##", …), which chunk.js's toSections() already
  // parses UNAMBIGUOUSLY — markdown syntax needs no blank-line-after check,
  // unlike the plain-text heuristic that PDFs could never satisfy in the
  // first place (see the old comment this replaced, and §6.4). A PDF with no
  // distinct heading size at all (rare, but possible — e.g. headings that are
  // only bolded, not enlarged) simply yields no detected headings, exactly as
  // before: this is a best-effort structural read, not a guarantee.
  const heightCounts = new Map();
  for (const lines of pageLines) {
    for (const { height } of lines) {
      if (!height) continue;
      heightCounts.set(height, (heightCounts.get(height) ?? 0) + 1);
    }
  }
  let bodyHeight = 0;
  let bodyCount = -1;
  for (const [height, count] of heightCounts) {
    if (count > bodyCount) {
      bodyHeight = height;
      bodyCount = count;
    }
  }
  const headingTiers = [...heightCounts.keys()]
    .filter((h) => h > bodyHeight * 1.15)
    .sort((a, b) => b - a);

  const pages = pageLines.map((lines) =>
    lines
      .map(({ text, height }) => {
        const tier = headingTiers.indexOf(height);
        return tier === -1 ? text : `${"#".repeat(Math.min(tier + 1, 6))} ${text}`;
      })
      .join("\n")
  );

  // The page count travels WITH the text. "Is this scanned?" is a question
  // about characters PER PAGE — a 40-page scan with a stray header is not
  // empty, it is empty-per-page — and the caller cannot judge that without it.
  return { text: pages.join("\n\n"), pageCount };
}

/** DOCX via mammoth, which understands the OpenXML structure rather than
 *  scraping the zip — so headings survive as headings for the chunker. */
async function extractDocx(buffer, structuredTables) {
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  if (structuredTables) return extractDocxStructured(mammoth, buffer);
  // Markdown rather than raw text: it preserves heading levels as `#`, which
  // the heading-aware chunker then splits on. Raw text would throw that away.
  const result = await mammoth.convertToMarkdown({ buffer: Buffer.from(buffer) });

  // Un-escape mammoth's markdown escaping. It emits `out\-of\-hours` and
  // `clinic\.` so the markdown round-trips — but nothing here renders markdown,
  // so those backslashes would be embedded, retrieved, and eventually quoted
  // back to a customer verbatim. Only escapes before markdown punctuation are
  // removed, so a genuine backslash in the document survives.
  return result.value.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, "$1");
}

/**
 * DOCX with its tables kept as tables (STRUCTURED_TABLES, §6.23). mammoth's markdown output has
 * no table syntax — every cell becomes a paragraph — so this reads its HTML instead: tables are
 * pulled out and rendered as self-describing rows, and everything around them (headings, lists)
 * goes through the same HTML → text step the website crawler uses, so a heading is still a "#".
 * Imported lazily, like every heavy dependency here, so a tenant who never uploads a DOCX
 * never loads any of it.
 */
async function extractDocxStructured(mammoth, buffer) {
  const { extractHtmlTables } = await import("./tables");
  const { htmlToText } = await import("./crawl");
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(buffer) });
  const { html, blocks } = extractHtmlTables(value);
  return htmlToText(html).replace(/@@TABLE_(\d+)@@/g, (_m, i) => blocks[Number(i)] ?? "");
}

/**
 * Extract text from an uploaded file.
 *
 * @param {object} args
 * @param {ArrayBuffer} args.buffer
 * @param {string} args.fileName
 * @param {boolean} [args.structuredTables] override of STRUCTURED_TABLES — tests and audits only
 * @returns {Promise<{ok: true, text: string} | {ok: false, reason: string}>}
 */
export async function extractText({ buffer, fileName, structuredTables = STRUCTURED_TABLES }) {
  const ext = extensionOf(fileName);

  try {
    let text;
    let pageCount = 0;
    if (ext === ".pdf") {
      const pdf = await extractPdf(buffer);
      text = pdf.text;
      pageCount = pdf.pageCount;
    } else if (ext === ".docx") {
      text = await extractDocx(buffer, structuredTables);
    } else {
      // txt / md / csv — decoded as UTF-8. `fatal: false` so a file with a
      // stray byte still yields its readable text instead of failing entirely.
      text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    }

    const cleaned = normalize(text);

    // A SCANNED PDF: pages of images with no text layer. Rather than rejecting
    // it, say so — the caller decides whether to spend the time on OCR, because
    // OCR belongs in a background job and this function may be called from a
    // request.
    if (ext === ".pdf" && looksScanned(cleaned, pageCount)) {
      return { ok: false, reason: "scanned", pageCount };
    }

    if (!cleaned) return { ok: false, reason: "noText" };
    return { ok: true, text: cleaned, pageCount };
  } catch (err) {
    console.error(`extractText failed for ${fileName}:`, err);
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Tidy extracted text without destroying its structure.
 *
 * Blank lines are load-bearing here — they are what the chunker uses to find
 * paragraph boundaries — so runs of them are collapsed to two, never removed.
 */
// Exported for tests/extract.test.js (pure string -> string).
export function normalize(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, "")
    // Soft hyphens and zero-width characters are common in PDF exports and
    // split words in the middle of an embedding.
    .replace(/[­​-‍﻿]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
