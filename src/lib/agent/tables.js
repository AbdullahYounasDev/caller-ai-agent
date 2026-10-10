import { humanizeTitle } from "./chunk";
import { decodeEntities, stripTags } from "./crawl";

/**
 * TABLES THAT KEEP THEIR MEANING — CSV, and the tables inside DOCX files (§6.23).
 *
 * A table is only meaningful with its header. "Pro,149,5,Unlimited" says nothing; "Plan: Pro;
 * Monthly Price EUR: 149; Stores: 5; SKUs: Unlimited" answers "how many stores on Pro?". The
 * pipeline used to throw that away two different ways:
 *
 *   CSV   chunked as one blob of comma-separated text with no heading (a heading-less chunk
 *         embeds as a bare fragment); a big one lost rows to the sentence splitter.
 *   DOCX  mammoth turns every table CELL into its own paragraph, and the chunker takes a short
 *         title-cased paragraph for a heading: "Lite", "Pro", "Unlimited" became headings and
 *         "Email", "Custom pricing" — a heading with no body — vanished from the text entirely.
 *
 * So both are rewritten as SELF-DESCRIBING ROWS, "Header: value; Header: value", each group of
 * rows led by a "Columns: …" line, so the column meanings travel into EVERY chunk. Pure and
 * dependency-light; nothing here touches a database or a model.
 *
 * Gated by STRUCTURED_TABLES in embed-scheme.js — it changes what gets embedded (§6.2).
 */

/** Rendered rows are grouped up to this size, well inside chunk.js's 1,400-char target, so a
 *  group lands as ONE chunk and chunk boundaries fall on row boundaries — never mid-row. */
export const TABLE_GROUP_CHARS = 1200;

const NUMERIC_CELL = /^[\d\s.,%€$£+-]+$/;
const DELIMITERS = [",", ";", "\t", "|"];

/** Collapse a cell to one tidy line. */
const clean = (cell) => String(cell ?? "").replace(/\s+/g, " ").trim();

/**
 * RFC 4180-style parser: quoted fields (with "" escapes and embedded delimiters/newlines),
 * CRLF/LF/CR rows, a UTF-8 BOM, and a missing final newline. Lenient on purpose — a stray quote
 * in the middle of an unquoted field is literal text, and an unterminated quote runs to the end
 * of the file — because the input is a business's hand-made spreadsheet export, not a spec.
 * Rows in which every cell is empty are dropped.
 *
 * @param {string} text
 * @param {string} [delimiter]
 * @returns {string[][]}
 */
export function parseDelimited(text, delimiter = ",") {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field.trim() === "") {
      inQuotes = true;
      field = "";
    } else if (c === delimiter) {
      endField();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else field += c;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/**
 * The delimiter a file uses: the candidate whose per-line count is most CONSISTENT over the
 * first lines (quoted text ignored). A European export separates with ";" because "," is the
 * decimal mark; a pasted table uses tabs. Falls back to ",".
 */
export function detectDelimiter(text) {
  const lines = String(text ?? "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/"[^"]*"/g, ""))
    .filter((l) => l.trim())
    .slice(0, 25);
  let best = ",";
  let bestScore = [0, 0];
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const freq = new Map();
    for (const n of counts) freq.set(n, (freq.get(n) ?? 0) + 1);
    let modal = 0;
    let modalFreq = 0;
    for (const [n, f] of freq) if (n > 0 && (f > modalFreq || (f === modalFreq && n > modal))) [modal, modalFreq] = [n, f];
    if (modal === 0) continue;
    if (modalFreq > bestScore[0] || (modalFreq === bestScore[0] && modal > bestScore[1])) {
      best = d;
      bestScore = [modalFreq, modal];
    }
  }
  return best;
}

/**
 * Is the first row a header? A header is words, not data: at least half its cells filled, none
 * purely numeric ("59", "12.50%", "€10"), no repeats, nothing paragraph-sized. A file with no
 * header ("Lite,59,1" first) fails the numeric test and gets generic "Column N" names instead —
 * its first row stays DATA rather than being eaten as a header.
 *
 * Deliberately conservative the other way too: an all-text table without a header ("Lite, Email,
 * Yes") looks like a header and is read as one. A wrong "yes" mislabels one row's cells; a wrong
 * "no" is merely less descriptive — and no heuristic can tell those two files apart.
 *
 * @param {string[]} row
 */
export function looksLikeHeader(row) {
  const cells = row.map(clean);
  const filled = cells.filter(Boolean);
  if (!filled.length || filled.length < Math.ceil(cells.length / 2)) return false;
  if (filled.some((c) => NUMERIC_CELL.test(c) || c.length > 60)) return false;
  return new Set(filled.map((c) => c.toLowerCase())).size === filled.length;
}

/**
 * @param {string[][]} rows
 * @returns {{headers: string[], data: string[][], hadHeader: boolean}}
 */
export function splitHeader(rows) {
  if (!rows.length) return { headers: [], data: [], hadHeader: false };
  const width = Math.max(...rows.map((r) => r.length));
  const hadHeader = rows.length > 1 && looksLikeHeader(rows[0]);
  const headers = Array.from({ length: width }, (_, i) => (hadHeader ? clean(rows[0][i]) : "") || `Column ${i + 1}`);
  return { headers, data: hadHeader ? rows.slice(1) : rows, hadHeader };
}

/**
 * One row as "Header: value; Header: value". Empty cells are OMITTED rather than rendered as an
 * empty value (which would read as a fact), and a cell past the header's width gets "Column N".
 * @returns {string} "" for a row with no values at all
 */
export function renderRow(headers, cells) {
  const parts = [];
  cells.forEach((cell, i) => {
    const value = clean(cell);
    if (value) parts.push(`${headers[i] ?? `Column ${i + 1}`}: ${value}`);
  });
  return parts.join("; ");
}

/**
 * Rendered rows, grouped so each group is at most `maxChars` and starts with a
 * "Columns: …" line — the header context that makes a chunk understandable on its own.
 * A single row longer than the limit is a group of one (never cut mid-row here).
 *
 * @param {string[]} headers
 * @param {string[][]} data
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function tableBlocks(headers, data, maxChars = TABLE_GROUP_CHARS) {
  const columns = `Columns: ${headers.join(", ")}`;
  const groups = [];
  let current = [];
  let size = columns.length;
  for (const cells of data) {
    const line = renderRow(headers, cells);
    if (!line) continue;
    if (current.length && size + line.length + 1 > maxChars) {
      groups.push(`${columns}\n${current.join("\n")}`);
      current = [];
      size = columns.length;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length) groups.push(`${columns}\n${current.join("\n")}`);
  return groups;
}

/**
 * A CSV file as a document: a heading from the file name, then groups of self-describing rows.
 * Each group is its OWN same-level section, so chunk.js splits exactly at group boundaries (no
 * overlap tails cutting a row in half) and every chunk carries the file-name heading.
 *
 * @param {string} text the CSV as stored
 * @param {{name?: string}} [options] the file name (or title); "12-storepulse-plans.csv" → "storepulse plans"
 * @returns {string|null} null when there is nothing table-like (the caller keeps the raw text)
 */
export function csvToDocument(text, { name } = {}) {
  const rows = parseDelimited(text, detectDelimiter(text));
  const { headers, data } = splitHeader(rows);
  const groups = tableBlocks(headers, data);
  if (!groups.length) return null;
  const heading = humanizeTitle(name) || "Table";
  return groups.map((g) => `# ${heading}\n\n${g}`).join("\n\n");
}

/** Text of one HTML table cell. */
const cellText = (html) => clean(decodeEntities(stripTags(html)));

/**
 * Replace every <table> in mammoth's HTML with a placeholder paragraph and return the tables
 * rendered as self-describing rows. The surrounding HTML then goes through the ordinary HTML →
 * text step (headings, lists), and the placeholders are swapped for the rendered blocks. The
 * heading ABOVE a table is already the chunk's heading, so none is added here.
 *
 * A nested table is left alone (the lazy match would split it wrongly); they are rare in
 * business documents and left to the old behaviour.
 *
 * @param {string} html
 * @returns {{html: string, blocks: string[]}} `blocks[i]` replaces the text "@@TABLE_i@@"
 */
export function extractHtmlTables(html) {
  const blocks = [];
  const out = String(html ?? "").replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (whole, inner) => {
    if (/<table\b/i.test(inner)) return whole;
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((tr) => [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1])))
      .filter((r) => r.some(Boolean));
    const { headers, data } = splitHeader(rows);
    const groups = tableBlocks(headers, data);
    if (!groups.length) return whole;
    blocks.push(groups.join("\n\n"));
    return `<p>@@TABLE_${blocks.length - 1}@@</p>`;
  });
  return { html: out, blocks };
}
