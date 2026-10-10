#!/usr/bin/env node
/**
 * CHUNK AUDIT — what does the pipeline actually produce for each real document?
 *
 * READ-ONLY and OFFLINE: it runs the real extractText() and the real chunking over every
 * file in test-docs/ and prints per-document statistics. No embedding, no model, nothing
 * written to the database. (The one scanned PDF is not OCR'd here: its text is read from the
 * copy already stored in Postgres for the eval tenant, if that is still there.)
 *
 *   npm run audit:chunks                          # to stdout
 *   npm run audit:chunks -- --out=report.txt      # and to a file
 *   npm run audit:chunks -- --dir=other-docs
 *   npm run audit:chunks -- --structured          # with the CSV/table conversion switched ON (§6.23)
 *   npm run audit:chunks -- --compare             # print old vs new chunks for files the conversion changes
 *
 * "Problem" columns, and why they matter:
 *   no-heading   a chunk with no heading path embeds as a bare fragment (a CSV row without its
 *                column names matches generic questions better than the real answer, TEST-REPORT §4)
 *   <MIN         under 180 chars: matches everything weakly (chunk.js MIN_CHARS)
 *   >MAX         over 1400 chars + the runt allowance: an oversized chunk dilutes its own vector
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const DIR = path.resolve(arg("dir") ?? "test-docs");
const OUT = arg("out");
const STRUCTURED = process.argv.includes("--structured");
const COMPARE = process.argv.includes("--compare");

const { extractText } = await import("@/lib/agent/extract");
const { chunkDocument, MIN_CHARS, TARGET_CHARS } = await import("@/lib/agent/chunk");
const { chunksForDocument } = await import("@/lib/agent/prepare");

const SUPPORTED = /\.(pdf|docx|txt|md|csv)$/i;
// A chunk may legitimately exceed TARGET_CHARS by the runt that was merged into it.
const OVER = TARGET_CHARS + MIN_CHARS + 2;

const lines = [];
const out = (s = "") => lines.push(s);

// Scanned PDFs: reuse the OCR text already in the database rather than running OCR again.
let storedContent = new Map();
try {
  process.loadEnvFile(".env");
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const rows = await prisma.$queryRaw`SELECT title, content FROM ai_engine.knowledge_sources WHERE tenant_id = ${process.env.EVAL_TENANT || "__eval_real__"}`;
  storedContent = new Map(rows.map((r) => [r.title, r.content]));
  await prisma.$disconnect();
} catch {
  /* no database: scanned PDFs are simply reported as skipped */
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];

const files = readdirSync(DIR).filter((f) => SUPPORTED.test(f) && statSync(path.join(DIR, f)).isFile()).sort();
const rowsOut = [];
const worst = [];

for (const file of files) {
  const buffer = readFileSync(path.join(DIR, file));
  let text;
  let note = "";
  const extracted = await extractText({ buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), fileName: file, structuredTables: STRUCTURED });
  if (extracted.ok) text = extracted.text;
  else if (extracted.reason === "scanned" && storedContent.get(file)) {
    text = storedContent.get(file);
    note = "scanned PDF — text from the stored OCR copy";
  } else {
    rowsOut.push({ file, skipped: extracted.reason });
    continue;
  }

  const chunks = STRUCTURED ? chunksForDocument({ text, title: file, fileName: file }, { structuredTables: true }) : chunkDocument(text);
  const sizes = chunks.map((c) => c.content.length).sort((a, b) => a - b);
  const headingless = chunks.filter((c) => !c.heading);
  const under = chunks.filter((c) => c.content.length < MIN_CHARS);
  const over = chunks.filter((c) => c.content.length > OVER);
  const stat = {
    file, note, chars: text.length, chunks: chunks.length,
    min: sizes[0] ?? 0, p50: pct(sizes, 50) ?? 0, p90: pct(sizes, 90) ?? 0, max: sizes.at(-1) ?? 0,
    headingless: headingless.length, under: under.length, over: over.length,
  };
  rowsOut.push(stat);
  const score = stat.headingless * 3 + stat.under + stat.over * 2;
  if (score) worst.push({ ...stat, score, samples: headingless.slice(0, 6).map((c) => c.content.replace(/\s+/g, " ").slice(0, 120)), underSamples: under.slice(0, 3).map((c) => c.content.replace(/\s+/g, " ").slice(0, 120)) });
}

out(`CHUNK AUDIT — ${DIR}${STRUCTURED ? "  [table conversion ON]" : ""}`);
out(`${files.length} files; limits: MIN ${MIN_CHARS}, TARGET ${TARGET_CHARS} chars\n`);
out("document".padEnd(36) + "chars".padStart(7) + "chunks".padStart(7) + "  size min/p50/p90/max".padEnd(26) + "no-heading".padStart(11) + "<MIN".padStart(6) + ">MAX".padStart(6));
for (const r of rowsOut) {
  if (r.skipped) { out(`${r.file.padEnd(36)}  SKIPPED (${r.skipped})`); continue; }
  out(
    r.file.padEnd(36) + String(r.chars).padStart(7) + String(r.chunks).padStart(7) +
      `  ${r.min}/${r.p50}/${r.p90}/${r.max}`.padEnd(26) + String(r.headingless).padStart(11) + String(r.under).padStart(6) + String(r.over).padStart(6) +
      (r.note ? `   (${r.note})` : "")
  );
}
const ok = rowsOut.filter((r) => !r.skipped);
out(`\nTOTAL ${ok.reduce((a, r) => a + r.chunks, 0)} chunks; ${ok.reduce((a, r) => a + r.headingless, 0)} without a heading, ${ok.reduce((a, r) => a + r.under, 0)} under ${MIN_CHARS}, ${ok.reduce((a, r) => a + r.over, 0)} over ${OVER}.`);

out("\nWORST OFFENDERS (heading-less x3, runt x1, oversize x2)");
for (const w of worst.sort((a, b) => b.score - a.score)) {
  out(`\n  ${w.file}  — ${w.chunks} chunks: ${w.headingless} no heading, ${w.under} under ${MIN_CHARS}, ${w.over} oversize`);
  for (const s of w.samples) out(`      [no heading] ${JSON.stringify(s)}`);
  for (const s of w.underSamples) out(`      [runt]       ${JSON.stringify(s)}`);
}

if (COMPARE) {
  out("\n\n══ BEFORE / AFTER for files the table conversion changes ══");
  for (const file of files.filter((f) => /\.(csv|docx)$/i.test(f))) {
    const buffer = readFileSync(path.join(DIR, file));
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    for (const [label, structured] of [["BEFORE", false], ["AFTER ", true]]) {
      // CSV is converted at chunk time, DOCX at extraction time — each toggle is passed to the seam that owns it.
      const extracted = await extractText({ buffer: ab, fileName: file, structuredTables: structured });
      if (!extracted.ok) continue;
      const chunks = chunksForDocument({ text: extracted.text, title: file, fileName: file }, { structuredTables: structured });
      out(`\n${file} — ${label}: ${chunks.length} chunk(s)`);
      chunks.forEach((c, i) => {
        out(`  chunk ${i + 1}  heading=${JSON.stringify(c.heading)}  ${c.content.length} chars`);
        out(`    content: ${JSON.stringify(c.content.slice(0, 260))}${c.content.length > 260 ? "…" : ""}`);
      });
    }
  }
}

const report = lines.join("\n");
console.log(report);
if (OUT) writeFileSync(OUT, report + "\n");
