import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { rankCandidates } from "@/lib/agent/retrieve";

// Rows are given in VECTOR ORDER (nearest first) — the index in the array IS the vector
// rank, exactly as STAGE 1's `ORDER BY distance` hands them over.
let n = 0;
const row = (source, heading, keywordRank = 0, over = {}) => {
  const id = over.id ?? `c${n++}`;
  return { id, sourceTitle: source, heading, content: `content of ${id}`, distance: 0.1 + n * 0.001, keywordRank, ...over };
};
const ids = (rows) => rows.map((r) => r.id);
const fresh = () => (n = 0);

describe("rankCandidates — shape", () => {
  test("empty in, empty out", () => {
    assert.deepEqual(rankCandidates([], 5), []);
  });

  test("returns at most topK rows, stripped of score and keywordRank, other fields intact", () => {
    fresh();
    const input = Array.from({ length: 8 }, (_, i) => row("Doc", `H${i}`, 0, { sourceUpdatedAt: new Date("2026-01-01") }));
    const out = rankCandidates(input, 5);
    assert.equal(out.length, 5);
    for (const r of out) {
      assert.deepEqual(Object.keys(r).sort(), ["content", "distance", "heading", "id", "sourceTitle", "sourceUpdatedAt"]);
    }
  });

  test("topK larger than the pool returns the whole pool; topK 0 returns nothing", () => {
    fresh();
    const input = [row("A", "x"), row("B", "y")];
    assert.equal(rankCandidates(input, 10).length, 2);
    assert.deepEqual(rankCandidates(input, 0), []);
  });

  test("does not mutate its input", () => {
    fresh();
    const input = [row("A", "x", 3), row("B", "y", 1), row("A", "z", 2)];
    const snapshot = JSON.stringify(input);
    rankCandidates(input, 2);
    assert.equal(JSON.stringify(input), snapshot);
  });
});

describe("rankCandidates — STAGE 2: reciprocal rank fusion", () => {
  test("with no keyword signal the vector order is kept", () => {
    fresh();
    const input = Array.from({ length: 10 }, (_, i) => row("Doc", `H${i}`));
    assert.deepEqual(ids(rankCandidates(input, 5)), ids(input.slice(0, 5)));
  });

  test("an exact-match chunk at vector rank 10 is promoted into the top 5", () => {
    fresh();
    const input = Array.from({ length: 10 }, (_, i) => row("Doc", `H${i}`, i === 9 ? 0.9 : 0));
    const out = ids(rankCandidates(input, 5));
    assert.ok(out.includes(input[9].id), "keyword hit promoted");
    assert.deepEqual(out.slice(0, 3), ids(input.slice(0, 3)), "…without displacing the strongest vector matches");
  });

  test("keywordRank may arrive as a string (Postgres numeric) and still ranks numerically", () => {
    fresh();
    const input = Array.from({ length: 10 }, (_, i) => row("Doc", `H${i}`, i === 9 ? "0.25" : "0"));
    assert.ok(ids(rankCandidates(input, 5)).includes(input[9].id));
    // "10" must not sort before "9" as text would
    // x (vector 0, kw "0"), y (vector 1, kw "9"), z (vector 2, kw "10"): numerically z has the
    // best keyword rank so it fuses above y; sorted as TEXT "9" > "10" and y would win.
    const pool = [row("Doc", "x", "0", { id: "x" }), row("Doc", "y", "9", { id: "y" }), row("Doc", "z", "10", { id: "z" })];
    const out = ids(rankCandidates(pool, 3));
    assert.ok(out.indexOf("z") < out.indexOf("y"), out.join(","));
  });

  test("a keyword signal alone can never ADMIT a chunk — output is always a subset of the input", () => {
    fresh();
    const input = [row("A", "a"), row("B", "b", 5)];
    const out = rankCandidates(input, 5);
    assert.deepEqual(ids(out).sort(), ids(input).sort());
  });
});

describe("rankCandidates — STAGE 3: document first, heading second", () => {
  // The §6.3 fixture: a dense pricing sheet (10 chunks, 10 DIFFERENT headings) and a
  // conflicting price list (1 relevant chunk) that vector search ranks 11th.
  const conflictFixture = () => {
    fresh();
    const sheet = Array.from({ length: 10 }, (_, i) => row("Pricing Sheet", `Plan ${i}`, 0, { id: `sheet${i}` }));
    const old = row("Old Price List", "Prices", 0, { id: "old0" });
    return { input: [...sheet, old], old };
  };

  // What the ORIGINAL stage 3 did — heading-only round-robin, no document axis. Kept here
  // only to prove the fixture reproduces the failure the document axis fixed.
  const headingOnly = (candidates, topK) => {
    const RRF_K = 60;
    const kw = [...candidates].sort((a, b) => Number(b.keywordRank) - Number(a.keywordRank));
    const vr = new Map(candidates.map((c, i) => [c.id, i]));
    const kr = new Map(kw.map((c, i) => [c.id, i]));
    const fused = candidates.map((c) => ({ ...c, score: 1 / (RRF_K + vr.get(c.id)) + 1 / (RRF_K + kr.get(c.id)) })).sort((a, b) => b.score - a.score);
    const groups = new Map();
    for (const c of fused) {
      const k = c.heading ?? "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const lists = [...groups.values()].sort((a, b) => b[0].score - a[0].score);
    const out = [];
    for (let r = 0; out.length < topK && lists.some((l) => l[r]); r++) for (const l of lists) if (l[r] && out.length < topK) out.push(l[r]);
    return out;
  };

  test("§6.3 CONFLICT: 10 chunks from one document and 1 from another BOTH reach topK 6", () => {
    const { input } = conflictFixture();
    const out = ids(rankCandidates(input, 6));
    assert.ok(out.includes("old0"), `the conflicting document was crowded out: ${out}`);
    assert.equal(out.filter((id) => id.startsWith("sheet")).length, 5);
  });

  test("…and the fixture really is the failing case: heading-only diversity drops the conflicting chunk", () => {
    const { input } = conflictFixture();
    assert.ok(!ids(headingOnly(input, 6)).includes("old0"));
  });

  test("the other document is represented in the FIRST round, not squeezed in last", () => {
    const { input } = conflictFixture();
    assert.deepEqual(ids(rankCandidates(input, 6)).slice(0, 2), ["sheet0", "old0"]);
  });

  test("HEADING CROWDING inside one document: five 'Plans' chunks do not crowd out 'Refunds'", () => {
    fresh();
    const input = [
      ...Array.from({ length: 5 }, (_, i) => row("Handbook", "Plans", 0, { id: `plans${i}` })),
      row("Handbook", "Refunds", 0, { id: "refunds0" }),
    ];
    const out = ids(rankCandidates(input, 3));
    assert.deepEqual(out, ["plans0", "refunds0", "plans1"]);
    // Pure vector order would have returned plans0..plans2 and never mentioned refunds.
  });

  test("documents are visited in order of their OWN best chunk, across rounds", () => {
    fresh();
    const input = [
      row("A", "a1", 0, { id: "A1" }),
      row("B", "b1", 0, { id: "B1" }),
      row("A", "a2", 0, { id: "A2" }),
      row("C", "c1", 0, { id: "C1" }),
      row("B", "b2", 0, { id: "B2" }),
      row("C", "c2", 0, { id: "C2" }),
    ];
    assert.deepEqual(ids(rankCandidates(input, 4)), ["A1", "B1", "C1", "A2"]);
  });

  test("a null heading and an empty heading are the same group", () => {
    fresh();
    const input = [row("Doc", null, 0, { id: "n0" }), row("Doc", "", 0, { id: "e0" }), row("Doc", "Other", 0, { id: "o0" })];
    // n0 and e0 share a group, so o0 is interleaved ahead of the group's second chunk.
    assert.deepEqual(ids(rankCandidates(input, 3)), ["n0", "o0", "e0"]);
  });

  test("topK cuts mid-round without duplicating or skipping", () => {
    fresh();
    const input = Array.from({ length: 6 }, (_, i) => row(`D${i % 3}`, `H${i}`));
    const out = ids(rankCandidates(input, 5));
    assert.equal(new Set(out).size, 5);
  });
});

describe("query embedding cache (retrieve.js embedQuery)", () => {
  test("an exact repeat is served from memory; a different text, or the same text with other words, is embedded", async () => {
    const { embedQuery } = await import("@/lib/agent/retrieve");
    const calls = [];
    const fake = async (text, options) => {
      calls.push({ text, role: options.role });
      return [text.length, 0.5];
    };
    const q = `cache-test ${Math.random()}`; // unique: the cache is module-level
    const a = await embedQuery(`  ${q}  `, fake);
    const b = await embedQuery(q, fake);
    assert.deepEqual(a, b);
    assert.equal(calls.length, 1, "the trimmed repeat did not call the embedder");
    assert.equal(calls[0].role, "query", "always embedded as a QUERY (§6.2)");
    await embedQuery(`${q}?`, fake);
    assert.equal(calls.length, 2, "punctuation is NOT normalised away — a different text is a different vector");
  });
});
