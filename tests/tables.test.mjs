import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseDelimited,
  detectDelimiter,
  looksLikeHeader,
  splitHeader,
  renderRow,
  tableBlocks,
  csvToDocument,
  extractHtmlTables,
  TABLE_GROUP_CHARS,
} from "@/lib/agent/tables";
import { chunksForDocument } from "@/lib/agent/prepare";
import { chunkDocument } from "@/lib/agent/chunk";
import { extractText } from "@/lib/agent/extract";
import { MAX_CHUNKS_PER_DOCUMENT } from "@/lib/agent/ingest";
import { STRUCTURED_TABLES } from "@/lib/agent/embed-scheme";

const allContent = (chunks) => chunks.map((c) => c.content).join("\n");

describe("parseDelimited", () => {
  test("plain rows, LF / CRLF / CR, and no trailing newline", () => {
    const want = [["a", "b"], ["c", "d"]];
    assert.deepEqual(parseDelimited("a,b\nc,d"), want);
    assert.deepEqual(parseDelimited("a,b\r\nc,d\r\n"), want);
    assert.deepEqual(parseDelimited("a,b\rc,d"), want);
  });

  test("QUOTED COMMAS stay inside one cell", () => {
    assert.deepEqual(parseDelimited('Plan,Support\nPro,"Email, phone and chat"'), [["Plan", "Support"], ["Pro", "Email, phone and chat"]]);
  });

  test('doubled quotes are a literal quote; a newline inside quotes stays in the cell', () => {
    assert.deepEqual(parseDelimited('a,"He said ""hi"""\n"two\nlines",x'), [["a", 'He said "hi"'], ["two\nlines", "x"]]);
  });

  test("EMPTY CELLS are kept in place (so columns do not shift); all-empty rows are dropped", () => {
    assert.deepEqual(parseDelimited("a,,c\n,,\n,b,\n"), [["a", "", "c"], ["", "b", ""]]);
  });

  test("a UTF-8 BOM does not become part of the first header", () => {
    assert.deepEqual(parseDelimited("﻿Plan,Price\nLite,59"), [["Plan", "Price"], ["Lite", "59"]]);
  });

  test("other delimiters", () => {
    assert.deepEqual(parseDelimited("a;b;c\n1;2;3", ";"), [["a", "b", "c"], ["1", "2", "3"]]);
    assert.deepEqual(parseDelimited("a\tb\n1\t2", "\t"), [["a", "b"], ["1", "2"]]);
  });

  test("lenient: a stray quote mid-field is literal; an unterminated quote runs to the end", () => {
    assert.deepEqual(parseDelimited('5" screen,ok'), [['5" screen', "ok"]]);
    assert.deepEqual(parseDelimited('a,"never closed\nstill the same cell'), [["a", "never closed\nstill the same cell"]]);
  });

  test("empty input", () => {
    assert.deepEqual(parseDelimited(""), []);
    assert.deepEqual(parseDelimited(null), []);
    assert.deepEqual(parseDelimited("\n\n  \n"), []);
  });
});

describe("detectDelimiter", () => {
  test("comma, semicolon, tab, pipe", () => {
    assert.equal(detectDelimiter("a,b,c\n1,2,3\n4,5,6"), ",");
    assert.equal(detectDelimiter("a;b;c\n1;2;3\n4;5;6"), ";");
    assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
    assert.equal(detectDelimiter("a|b|c\n1|2|3"), "|");
  });

  test("a European export: ';' separates and ',' is the decimal mark", () => {
    assert.equal(detectDelimiter("Piano;Prezzo;Note\nLite;59,50;base\nPro;149,00;esteso"), ";");
  });

  test("delimiters inside quoted text do not count", () => {
    assert.equal(detectDelimiter('Plan;Note\nPro;"a, b, c, d"\nLite;"x, y, z"'), ";");
  });

  test("a single-column file or nonsense falls back to a comma", () => {
    assert.equal(detectDelimiter("one\ntwo\nthree"), ",");
    assert.equal(detectDelimiter(""), ",");
  });
});

describe("header detection (missing header)", () => {
  test("words are a header; numbers are data", () => {
    assert.equal(looksLikeHeader(["Plan", "Monthly Price EUR", "Stores"]), true);
    assert.equal(looksLikeHeader(["Lite", "59", "1"]), false, "a numeric cell: it is a data row");
    assert.equal(looksLikeHeader(["Q1", "12.5%", "€10"]), false);
  });

  test("repeats, paragraph-sized cells and mostly-empty rows are not headers", () => {
    assert.equal(looksLikeHeader(["Name", "name"]), false);
    assert.equal(looksLikeHeader(["x".repeat(61), "y"]), false);
    assert.equal(looksLikeHeader(["", "", "Price"]), false, "fewer than half filled");
    assert.equal(looksLikeHeader(["", "Price", "Stores"]), true, "a blank top-left cell is common in exports");
  });

  test("with a header the first row is consumed and named; without one it stays DATA with 'Column N' names", () => {
    const withH = splitHeader([["Plan", "Price"], ["Lite", "59"]]);
    assert.deepEqual(withH, { headers: ["Plan", "Price"], data: [["Lite", "59"]], hadHeader: true });
    const without = splitHeader([["Lite", "59"], ["Pro", "149"]]);
    assert.deepEqual(without.headers, ["Column 1", "Column 2"]);
    assert.equal(without.data.length, 2, "the first row was NOT swallowed as a header");
    assert.equal(without.hadHeader, false);
  });

  test("a lone row is never treated as a header (there would be no data)", () => {
    assert.equal(splitHeader([["Plan", "Price"]]).data.length, 1);
  });

  test("blank header names and ragged rows get 'Column N'", () => {
    const { headers } = splitHeader([["", "Price", "Stores"], ["Lite", "59", "1", "extra"]]);
    assert.deepEqual(headers, ["Column 1", "Price", "Stores", "Column 4"]);
  });
});

describe("renderRow", () => {
  const H = ["Plan", "Price", "Stores"];
  test("self-describing, empty cells omitted (an empty value would read as a fact)", () => {
    assert.equal(renderRow(H, ["Pro", "149", "5"]), "Plan: Pro; Price: 149; Stores: 5");
    assert.equal(renderRow(H, ["Pro", "", "5"]), "Plan: Pro; Stores: 5");
    assert.equal(renderRow(H, ["Pro", "  ", "\n"]), "Plan: Pro");
  });
  test("a cell past the header's width is still kept; an all-empty row renders nothing", () => {
    assert.equal(renderRow(H, ["Pro", "149", "5", "extra"]), "Plan: Pro; Price: 149; Stores: 5; Column 4: extra");
    assert.equal(renderRow(H, ["", "", ""]), "");
  });
  test("whitespace inside a cell is collapsed to one line", () => {
    assert.equal(renderRow(["Note"], ["line one\n  line   two"]), "Note: line one line two");
  });
});

describe("csvToDocument", () => {
  const SAMPLE = "Plan,Monthly Price EUR,Stores,SKUs,Support\nLite,59,1,500,Email (business hours)\nPro,149,5,Unlimited,Email + Phone (extended hours)\nEnterprise,Custom,Unlimited,Unlimited,24/7 dedicated\n";

  test("12-storepulse-plans.csv: a heading from the file name, the columns, and a self-describing row each", () => {
    assert.equal(
      csvToDocument(SAMPLE, { name: "12-storepulse-plans.csv" }),
      [
        "# storepulse plans",
        "",
        "Columns: Plan, Monthly Price EUR, Stores, SKUs, Support",
        "Plan: Lite; Monthly Price EUR: 59; Stores: 1; SKUs: 500; Support: Email (business hours)",
        "Plan: Pro; Monthly Price EUR: 149; Stores: 5; SKUs: Unlimited; Support: Email + Phone (extended hours)",
        "Plan: Enterprise; Monthly Price EUR: Custom; Stores: Unlimited; SKUs: Unlimited; Support: 24/7 dedicated",
      ].join("\n")
    );
  });

  test("quoted commas, empty cells, a BOM and CRLF together", () => {
    const csv = '﻿Plan,Support,Stores\r\nPro,"Email, phone",5\r\nLite,,1\r\n';
    const doc = csvToDocument(csv, { name: "plans.csv" });
    assert.match(doc, /Plan: Pro; Support: Email, phone; Stores: 5/);
    assert.match(doc, /Plan: Lite; Stores: 1\b/);
    assert.ok(!doc.includes("﻿"));
    assert.ok(!doc.includes("Support: ;"));
  });

  test("semicolon-delimited with decimal commas", () => {
    const doc = csvToDocument("Piano;Prezzo\nLite;59,50\nPro;149,00", { name: "piani.csv" });
    assert.match(doc, /Plan|Piano: Lite; Prezzo: 59,50/);
    assert.match(doc, /Piano: Pro; Prezzo: 149,00/);
  });

  test("a MISSING HEADER: generic column names, and NO row is lost", () => {
    const doc = csvToDocument("Lite,59,1\nPro,149,5\nEnterprise,Custom,Unlimited", { name: "x.csv" });
    assert.match(doc, /Columns: Column 1, Column 2, Column 3/);
    for (const row of ["Column 1: Lite; Column 2: 59; Column 3: 1", "Column 1: Pro; Column 2: 149", "Column 1: Enterprise; Column 2: Custom"]) {
      assert.ok(doc.includes(row), row);
    }
  });

  test("nothing table-like → null, so the caller keeps the raw text", () => {
    assert.equal(csvToDocument("", { name: "a.csv" }), null);
    assert.equal(csvToDocument("\n\n", { name: "a.csv" }), null);
    // A file whose only surviving row is its first row keeps it, as DATA — nothing is silently dropped.
    assert.match(csvToDocument("Plan,Price,Stores\n,,\n", { name: "a.csv" }), /Column 1: Plan; Column 2: Price; Column 3: Stores/);
  });

  test("the heading falls back when there is no usable name", () => {
    assert.match(csvToDocument("a,b\n1,2", {}), /^# Table\n/);
  });

  test("a large table is grouped; every group is its own chunk, repeats the columns and starts at a row boundary", () => {
    const rows = ["Name,Price,Note", ...Array.from({ length: 200 }, (_, i) => `Item ${i},${i * 3},Some descriptive note number ${i}`)];
    const doc = csvToDocument(rows.join("\n"), { name: "catalog.csv" });
    const chunks = chunkDocument(doc, { lossless: false });
    assert.ok(chunks.length > 5);
    for (const c of chunks) {
      assert.equal(c.heading, "catalog", "the file-name heading is on EVERY chunk");
      assert.ok(c.content.startsWith("Columns: Name, Price, Note\n"), "…and so are the column names");
      assert.ok(c.content.length <= TABLE_GROUP_CHARS + 200, `chunk of ${c.content.length}`);
      for (const line of c.content.split("\n").slice(1)) assert.match(line, /^Name: Item \d+; Price: \d+; Note: .+\d$/, "no row cut in half");
    }
    // every row exactly once
    const text = allContent(chunks);
    for (let i = 0; i < 200; i++) assert.equal(text.split(`Name: Item ${i};`).length - 1, 1, `row ${i}`);
  });

  test("EVERY row survives chunking in the shipped (legacy) mode — the legacy sentence splitter is never reached", () => {
    const rows = ["Plan,Price", ...Array.from({ length: 150 }, (_, i) => `Item${i},${i}`)];
    const chunks = chunksForDocument({ text: rows.join("\n"), title: "t", fileName: "t.csv" }, { structuredTables: true, lossless: false });
    const text = allContent(chunks);
    for (let i = 0; i < 150; i++) assert.ok(text.includes(`Plan: Item${i}; Price: ${i}`), `row ${i}`);
  });

  test("HUGE: a 20,000-row CSV converts quickly, loses nothing, and exceeds the per-document chunk cap (ingest then refuses it)", () => {
    const rows = ["Sku,Name,Price", ...Array.from({ length: 20_000 }, (_, i) => `S${i},Product number ${i},${(i % 500) + 0.99}`)];
    const csv = rows.join("\n");
    const t0 = Date.now();
    const doc = csvToDocument(csv, { name: "big-catalog.csv" });
    const chunks = chunksForDocument({ text: csv, title: "big", fileName: "big-catalog.csv" }, { structuredTables: true });
    assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0}ms`);
    assert.ok(chunks.length > MAX_CHUNKS_PER_DOCUMENT, `${chunks.length} chunks vs the cap of ${MAX_CHUNKS_PER_DOCUMENT}`);
    assert.equal(doc.split("Sku: S").length - 1, 20_000, "the converter itself drops no row — the cap is ingest's decision, with its own error message");
    assert.equal(MAX_CHUNKS_PER_DOCUMENT, 400);
  });

  test("a table that fits under the cap stays far below it", () => {
    const rows = ["Plan,Price", ...Array.from({ length: 300 }, (_, i) => `Plan ${i},${i}`)];
    const chunks = chunksForDocument({ text: rows.join("\n"), title: "t", fileName: "t.csv" }, { structuredTables: true });
    assert.ok(chunks.length < MAX_CHUNKS_PER_DOCUMENT / 4, `${chunks.length}`);
  });

  test("a single enormous cell is kept whole in lossless mode (one row can exceed a chunk)", () => {
    const big = "word ".repeat(5_000).trim();
    const chunks = chunksForDocument({ text: `Name,Notes\nA,${big}\nB,small`, title: "t", fileName: "t.csv" }, { structuredTables: true, lossless: true });
    const text = allContent(chunks);
    assert.ok(text.includes("Name: B; Notes: small"));
    assert.ok(text.split("word").length - 1 >= 5_000, "no word of the giant cell was dropped");
  });
});

describe("chunksForDocument — where the conversion applies", () => {
  const csv = "Plan,Price\nLite,59\nPro,149\n";

  test("OFF (the shipped default): a CSV is chunked exactly as before — nothing changes until the scheme is adopted", () => {
    assert.deepEqual(chunksForDocument({ text: csv, title: "p.csv", fileName: "p.csv" }, { structuredTables: false }), chunkDocument(csv));
    assert.deepEqual(chunksForDocument({ text: csv, title: "p.csv", fileName: "p.csv" }), chunksForDocument({ text: csv, title: "p.csv", fileName: "p.csv" }, { structuredTables: STRUCTURED_TABLES }));
  });

  test("ON: only files named *.csv are converted, case-insensitively; everything else is untouched", () => {
    const on = (fileName) => chunksForDocument({ text: csv, title: "t", fileName }, { structuredTables: true });
    assert.equal(on("PRICES.CSV")[0].heading, "PRICES");
    assert.deepEqual(on("notes.txt"), chunkDocument(csv));
    assert.deepEqual(on(undefined), chunkDocument(csv));
    assert.deepEqual(on(null), chunkDocument(csv));
  });

  test("ON, but the text is not table-like → raw text, never an empty document", () => {
    assert.deepEqual(chunksForDocument({ text: "\n,,\n", title: "t", fileName: "t.csv" }, { structuredTables: true }), chunkDocument("\n,,\n"));
  });
});

describe("extractHtmlTables (DOCX)", () => {
  const table = (rows) => `<table>${rows.map((r) => `<tr>${r.map((c) => `<td><p><strong>${c}</strong></p></td>`).join("")}</tr>`).join("")}</table>`;

  test("a table becomes a placeholder paragraph plus a self-describing block", () => {
    const { html, blocks } = extractHtmlTables(`<h2>Plan Comparison</h2>${table([["Plan", "Price"], ["Lite", "59 euro/month"], ["Pro", "149 euro/month"]])}<p>After.</p>`);
    assert.equal(html, "<h2>Plan Comparison</h2><p>@@TABLE_0@@</p><p>After.</p>");
    assert.equal(blocks[0], "Columns: Plan, Price\nPlan: Lite; Price: 59 euro/month\nPlan: Pro; Price: 149 euro/month");
  });

  test("<th> headers, entities and several tables, indexed in order", () => {
    const t1 = "<table><tr><th>Item</th><th>Cost</th></tr><tr><td>R&amp;D</td><td>5&nbsp;euro</td></tr></table>";
    const { html, blocks } = extractHtmlTables(`${t1}<p>x</p>${table([["A", "B"], ["1", "2"]])}`);
    assert.match(html, /@@TABLE_0@@.*@@TABLE_1@@/);
    assert.match(blocks[0], /Item: R&D; Cost: 5\s*euro/);
    assert.match(blocks[1], /A: 1; B: 2/);
  });

  test("a nested table, an empty table and a table with no data rows are left exactly as they were", () => {
    const nested = "<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>";
    assert.equal(extractHtmlTables(nested).html, nested);
    assert.deepEqual(extractHtmlTables(nested).blocks, []);
    const empty = "<table></table>";
    assert.equal(extractHtmlTables(empty).html, empty);
    const headerOnly = table([["Plan", "Price"]]);
    assert.ok(extractHtmlTables(headerOnly).blocks.length === 1, "a lone row is data, not a header");
  });

  test("no tables, no change", () => {
    assert.deepEqual(extractHtmlTables("<p>plain</p>"), { html: "<p>plain</p>", blocks: [] });
    assert.deepEqual(extractHtmlTables(null), { html: "", blocks: [] });
  });
});

describe("a real DOCX, end to end (test-docs/03-storepulse-pricing-plans.docx)", () => {
  const file = readFileSync("test-docs/03-storepulse-pricing-plans.docx");
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

  test("OFF: the legacy extraction is untouched (table cells as separate paragraphs)", async () => {
    const r = await extractText({ buffer, fileName: "03.docx", structuredTables: false });
    assert.ok(r.text.includes("__Plan__"));
    assert.ok(!r.text.includes("Plan: Lite"));
  });

  test("ON: the table is self-describing, nothing else in the document is lost, headings stay headings", async () => {
    const r = await extractText({ buffer, fileName: "03.docx", structuredTables: true });
    assert.ok(r.ok);
    for (const kept of [
      "Plan: Lite; Price: 59 euro/month; Stores: 1 store; Support: Email",
      "Plan: Pro; Price: 149 euro/month; Stores: Up to 5; Support: Email + Phone",
      "Plan: Enterprise; Price: Custom pricing; Stores: Unlimited; Support: 24/7 dedicated",
      "## Lite Plan",
      "149 euro per month. Up to 5 stores",
      "Barcode and label printing module: 19 euro/month",
    ]) assert.ok(r.text.includes(kept), kept);
    assert.ok(!r.text.includes("@@TABLE_"), "no placeholder leaked");
    const chunks = chunkDocument(r.text);
    const table = chunks.find((c) => c.content.startsWith("Columns:"));
    assert.equal(table.heading, "StorePulse Pricing Plans > Plan Comparison");
    assert.ok(!chunks.some((c) => /^(Lite|Pro|Unlimited)$/.test(c.heading.split(" > ").at(-1))), "no table cell is a heading any more");
  });
});
