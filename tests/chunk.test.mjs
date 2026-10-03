import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  chunkDocument,
  detectHeading,
  hardSplit,
  mergeRunts,
  humanizeTitle,
  TARGET_CHARS,
  MIN_CHARS,
  OVERLAP_CHARS,
} from "@/lib/agent/chunk";
import { CHUNK_LOSSLESS } from "@/lib/agent/embed-scheme";

/** Filler prose of roughly `n` characters, made of whole sentences. */
const prose = (n, tag = "x") => {
  let out = "";
  for (let i = 0; out.length < n; i++) out += `Sentence ${tag}${i} says something useful. `;
  return out.trim();
};
const allContent = (chunks) => chunks.map((c) => c.content).join("\n");

describe("detectHeading", () => {
  test("markdown headings need no blank line and report their level", () => {
    assert.deepEqual(detectHeading("## Pricing", "Body text follows directly"), { level: 2, text: "Pricing" });
    assert.deepEqual(detectHeading("# Title", undefined), { level: 1, text: "Title" });
    assert.deepEqual(detectHeading("###### Deep", "x"), { level: 6, text: "Deep" });
  });

  test("seven #s or a # with no text is not a markdown heading", () => {
    // Falls through to the plain-text path, which then refuses it for its next line.
    assert.equal(detectHeading("####### Too deep", "text below"), null);
    assert.equal(detectHeading("#hashtag", "text below"), null);
  });

  test("label/value lines are never headings (§6.4)", () => {
    for (const line of ["Phone: 123", "Email: info@example.com", "Source: https://example.com/a", "Open Hours: 9-5"]) {
      assert.equal(detectHeading(line, ""), null, line);
    }
  });

  test("a bare URL or email is never a heading (§6.4)", () => {
    for (const line of ["https://example.com/pricing", "www.example.com", "info@example.com", "HTTP://EXAMPLE.COM"]) {
      assert.equal(detectHeading(line, ""), null, line);
    }
  });

  test("numbered headings lose their number and are level 2", () => {
    assert.deepEqual(detectHeading("3. Refunds", ""), { level: 2, text: "Refunds" });
    assert.deepEqual(detectHeading("2) Opening Hours", ""), { level: 2, text: "Opening Hours" });
  });

  test("ALL CAPS is level 1, Title Case is level 2", () => {
    assert.deepEqual(detectHeading("OPENING HOURS", ""), { level: 1, text: "OPENING HOURS" });
    assert.deepEqual(detectHeading("Opening Hours", ""), { level: 2, text: "Opening Hours" });
    assert.deepEqual(detectHeading("Perché Scegliere Noi", ""), { level: 2, text: "Perché Scegliere Noi" });
  });

  test("a plain-text heading must be followed by a blank line (the PDF case, §6.4)", () => {
    assert.equal(detectHeading("1. Refunds", "We refund within 14 days."), null);
    assert.equal(detectHeading("Opening Hours", "Mon-Fri 9-5"), null);
    assert.notEqual(detectHeading("Opening Hours", "   "), null, "whitespace-only counts as blank");
  });

  test("sentences, lowercase phrases and long lines are not headings", () => {
    assert.equal(detectHeading("We open at nine.", ""), null);
    assert.equal(detectHeading("what are your opening hours?", ""), null);
    assert.equal(detectHeading("just some lowercase words here", ""), null);
    assert.equal(detectHeading("One Two Three Four Five Six Seven Eight Nine Ten", ""), null, "> 9 words");
    assert.equal(detectHeading("A".repeat(81), ""), null, "> 80 chars");
    assert.equal(detectHeading("   ", ""), null);
  });

  test("the last line of a document counts as blank-followed only in legacy mode", () => {
    // This is bug 2 of embed-scheme.js CHUNK_LOSSLESS: nothing follows the last line,
    // which the legacy rule read as "a blank line follows".
    assert.deepEqual(detectHeading("Prices Include VAT", undefined), { level: 2, text: "Prices Include VAT" });
    assert.equal(detectHeading("Prices Include VAT", undefined, { endIsBlank: false }), null);
    // …and a markdown heading is a heading wherever it is.
    assert.notEqual(detectHeading("## Last", undefined, { endIsBlank: false }), null);
  });
});

describe("hardSplit", () => {
  const sample = Array.from({ length: 3000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

  test("pieces are TARGET_CHARS long and each repeats the previous piece's tail", () => {
    const pieces = hardSplit(sample);
    assert.equal(pieces[0].length, TARGET_CHARS);
    for (let i = 1; i < pieces.length; i++) {
      assert.equal(pieces[i].slice(0, OVERLAP_CHARS), pieces[i - 1].slice(-OVERLAP_CHARS));
      assert.ok(pieces[i].length <= TARGET_CHARS);
    }
  });

  test("dropping each overlap reconstructs the input exactly (nothing lost)", () => {
    const pieces = hardSplit(sample);
    const rebuilt = pieces[0] + pieces.slice(1).map((p) => p.slice(OVERLAP_CHARS)).join("");
    assert.equal(rebuilt, sample);
  });

  test("text that fits is one piece; an exact fit does not produce an empty tail piece", () => {
    assert.deepEqual(hardSplit("short"), ["short"]);
    const exact = "z".repeat(TARGET_CHARS);
    assert.deepEqual(hardSplit(exact), [exact]);
    assert.deepEqual(hardSplit(""), []);
  });
});

describe("mergeRunts", () => {
  const big = (c) => c.repeat(MIN_CHARS + 20);

  test("a runt at the START merges FORWARD into the next piece (§6.4)", () => {
    const out = mergeRunts(["See below.", big("a")]);
    assert.equal(out.length, 1);
    assert.equal(out[0], `See below.\n\n${big("a")}`);
  });

  test("a trailing or middle runt merges BACKWARD into the previous piece", () => {
    assert.deepEqual(mergeRunts([big("a"), "tiny"]), [`${big("a")}\n\ntiny`]);
    assert.deepEqual(mergeRunts([big("a"), "tiny", big("b")]), [`${big("a")}\n\ntiny`, big("b")]);
  });

  test("a lone runt, nothing, and all-big input are left alone", () => {
    assert.deepEqual(mergeRunts(["tiny"]), ["tiny"]);
    assert.deepEqual(mergeRunts([]), []);
    assert.deepEqual(mergeRunts([big("a"), big("b")]), [big("a"), big("b")]);
  });

  test("a run of runts collapses into one piece, none dropped", () => {
    const out = mergeRunts(["a", "b", "c"]);
    assert.deepEqual(out, ["a\n\nb\n\nc"]);
  });
});

describe("chunkDocument", () => {
  test("a markdown document: heading path on every chunk, body kept clean", () => {
    const md = [
      "# Pricing",
      "",
      "## Whitening",
      "",
      `Whitening costs 250 euros. ${prose(200)}`,
      "",
      "## Cleaning",
      "",
      `Cleaning costs 80 euros. ${prose(200)}`,
    ].join("\n");
    const chunks = chunkDocument(md);

    assert.deepEqual(chunks.map((c) => c.heading), ["Pricing > Whitening", "Pricing > Cleaning"]);
    for (const c of chunks) {
      assert.ok(c.embedText.startsWith(`${c.heading}\n\n`), "breadcrumb is prepended to embedText");
      assert.ok(!c.content.includes(c.heading), "…but never to the quoted content");
      assert.equal(c.embedText, `${c.heading}\n\n${c.content}`);
    }
  });

  test("a sibling heading REPLACES the previous one instead of accumulating", () => {
    const md = `# A\n\n## B\n\n${prose(220)}\n\n## C\n\n${prose(220)}\n\n# D\n\n${prose(220)}`;
    assert.deepEqual(chunkDocument(md).map((c) => c.heading), ["A > B", "A > C", "D"]);
  });

  test("a heading-less document is one section; embedText is just the content", () => {
    const text = `${prose(300, "p")}\n\n${prose(300, "q")}`;
    const chunks = chunkDocument(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].heading, "");
    assert.equal(chunks[0].embedText, chunks[0].content);
  });

  test("empty / whitespace / nullish input yields no chunks", () => {
    for (const input of ["", "   \n\n  ", null, undefined]) assert.deepEqual(chunkDocument(input), []);
  });

  test("a small CSV is ONE chunk with every row (lossless mode)", () => {
    const rows = ["Plan,Monthly Price,Seats", "Starter,10,1", "Growth,25,5", "Scale,90,50"];
    const chunks = chunkDocument(rows.join("\n"), { lossless: true });
    assert.equal(chunks.length, 1);
    for (const r of rows) assert.ok(chunks[0].content.includes(r), r);
    // Legacy mode: the final row reads as a heading ("a blank line follows") and is dropped.
    const legacy = chunkDocument(rows.join("\n"), { lossless: false });
    assert.ok(!allContent(legacy).includes("Scale,90,50"));
    assert.ok(allContent(legacy).includes("Growth,25,5"));
  });

  test("a title is carried into embedText only, humanised, and not repeated by an H1", () => {
    const [c] = chunkDocument(`# Storepulse Plans\n\n${prose(250)}`, { title: "12-storepulse-plans.csv" });
    assert.ok(c.embedText.startsWith("Storepulse Plans\n\n"), "H1 repeating the title is said once");
    assert.ok(!c.content.includes("storepulse"));
    const [d] = chunkDocument(`# Intro\n\n${prose(250)}`, { title: "12-storepulse-plans.csv" });
    assert.ok(d.embedText.startsWith("storepulse plans > Intro\n\n"));
    assert.equal(humanizeTitle("2024 report.pdf"), "2024 report", "a year is not an ordering prefix");
  });

  test("an oversized section is split, every chunk bounded, and the tail of one reappears in the next", () => {
    const text = `# Policy\n\n${prose(4000)}`;
    const chunks = chunkDocument(text);
    assert.ok(chunks.length >= 3);
    for (const c of chunks) assert.ok(c.content.length <= TARGET_CHARS + MIN_CHARS + 2, `chunk of ${c.content.length}`);
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].content.slice(-40);
      assert.ok(chunks[i].content.includes(tail.trim().slice(-30)), "overlap carried between sub-chunks");
    }
  });

  describe("§6.4 regressions", () => {
    test("REGRESSION: a contact line under a heading is not swallowed as a heading", () => {
      const text = `# Contact\n\nPhone: +39 02 1234567\n\n# Hours\n\n${prose(200)}`;
      assert.ok(allContent(chunkDocument(text)).includes("Phone: +39 02 1234567"));
    });

    test("REGRESSION: plain-text label/value and URL lines survive in a heading-less doc", () => {
      const text = [
        "About Us",
        "",
        prose(200),
        "",
        "Phone: 0123 456789",
        "",
        "Email: hello@example.com",
        "",
        "https://example.com/contact",
        "",
        "Pricing",
        "",
        prose(200),
      ].join("\n");
      const content = allContent(chunkDocument(text));
      for (const kept of ["Phone: 0123 456789", "Email: hello@example.com", "https://example.com/contact"]) {
        assert.ok(content.includes(kept), kept);
      }
    });

    test("REGRESSION: a numbered line with text directly under it is NOT a heading (why PDFs promote headings to # first)", () => {
      // extractPdf joins lines with a single \n, never a blank line, so the plain-text
      // rule can never fire on a PDF. The numbered line stays body text…
      const flat = chunkDocument(`1. Refunds\nWe refund within 14 days of purchase, no questions asked.`);
      assert.equal(flat[0].heading, "");
      assert.ok(flat[0].content.startsWith("1. Refunds"));
      // …while the markdown the PDF extractor emits instead IS split.
      const promoted = chunkDocument(`## Refunds\nWe refund within 14 days of purchase, no questions asked.`);
      assert.equal(promoted[0].heading, "Refunds");
    });

    test("REGRESSION: a run-on sentence longer than TARGET_CHARS is hard-split, not emitted as one giant chunk", () => {
      const runOn = Array.from({ length: 700 }, (_, i) => `word${i}`).join(" "); // ~4.7k chars, no punctuation
      const chunks = chunkDocument(runOn);
      assert.ok(chunks.length >= 3, `got ${chunks.length}`);
      for (const c of chunks) assert.ok(c.content.length <= TARGET_CHARS + MIN_CHARS + 2);
      // overlap: the last words of a chunk reappear at the start of the next
      const lastWord = chunks[0].content.split(" ").at(-1);
      assert.ok(chunks[1].content.includes(lastWord));
    });

    test("REGRESSION: a leading runt merges forward instead of standing alone as a fragment", () => {
      const chunks = chunkDocument(`# Terms\n\nSee below.\n\n${prose(1500)}`);
      assert.ok(chunks.every((c) => c.content.length >= MIN_CHARS), "no fragment chunk");
      assert.ok(chunks[0].content.startsWith("See below."));
    });

    test("REGRESSION: a rule split across two paragraphs lands whole in at least one chunk (paragraph overlap)", () => {
      const p1 = `${prose(900, "a")} The deposit is refundable`;
      const p2 = `only if cancelled 48 hours ahead. ${prose(900, "b")}`;
      const chunks = chunkDocument(`# Deposit\n\n${p1}\n\n${p2}`);
      assert.ok(chunks.length >= 2);
      assert.ok(chunks.some((c) => c.content.includes("refundable") && c.content.includes("48 hours ahead")));
    });
  });

  describe("CHUNK_LOSSLESS (embed-scheme.js) — text must not vanish", () => {
    // PDF text as extractPdf emits it: hard-wrapped lines, NO blank lines, > TARGET_CHARS.
    const wrappedLines = (() => {
      const words = "we offer a wide range of dental services including cleaning whitening and implants for all ages".split(" ");
      const lines = [];
      let line = [];
      for (let n = 0; lines.join("\n").length < 1800; n++) {
        line.push(words[n % words.length]);
        if (line.join(" ").length > 45) {
          lines.push(line.join(" "));
          line = [];
        }
      }
      lines.push("The end of the section is here.");
      return lines;
    })();
    const missing = (lines, chunks) => lines.filter((l) => !allContent(chunks).includes(l));

    test("lossless: every hard-wrapped PDF line of a long section is kept", () => {
      const chunks = chunkDocument(`# Services\n\n${wrappedLines.join("\n")}`, { lossless: true });
      assert.deepEqual(missing(wrappedLines, chunks), []);
    });

    test("lossless: every row of a large CSV (no periods) is kept", () => {
      const rows = ["Plan,Price", ...Array.from({ length: 150 }, (_, i) => `Item${i},${i}`)];
      const chunks = chunkDocument(rows.join("\n"), { lossless: true });
      assert.ok(chunks.length > 1);
      assert.deepEqual(missing(rows, chunks), []);
    });

    test("lossless: the LAST line of a document is content, not a dropped heading", () => {
      const doc = `${prose(300)}\n\nPrices Include VAT`;
      assert.ok(allContent(chunkDocument(doc, { lossless: true })).includes("Prices Include VAT"));
    });

    test("lossless: prose with real sentences chunks the same text it always did", () => {
      const doc = `# Policy\n\n${prose(4000)}`;
      const strip = (cs) => cs.map((c) => c.content.replace(/\s+/g, " "));
      assert.deepEqual(strip(chunkDocument(doc, { lossless: true })), strip(chunkDocument(doc, { lossless: false })));
    });

    test("legacy mode is UNCHANGED — pinned so adopting the fix is a deliberate act (flag + scheme bump + re-embed)", () => {
      const chunks = chunkDocument(`# Services\n\n${wrappedLines.join("\n")}`, { lossless: false });
      assert.equal(missing(wrappedLines, chunks).length, wrappedLines.length - 1, "legacy keeps only the final line");
      assert.ok(!allContent(chunkDocument(`${prose(300)}\n\nPrices Include VAT`, { lossless: false })).includes("Prices Include VAT"));
    });

    test("the default follows the CHUNK_LOSSLESS flag", () => {
      const doc = `# Services\n\n${wrappedLines.join("\n")}`;
      assert.deepEqual(chunkDocument(doc), chunkDocument(doc, { lossless: CHUNK_LOSSLESS }));
    });
  });
});
