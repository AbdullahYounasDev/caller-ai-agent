import "./helpers/no-db.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rankCandidates } from "@/lib/agent/retrieve";
import { legacyRank } from "./helpers/legacy-rank.mjs";

// Proof that extracting rankCandidates() from retrieveRelevantChunks changed nothing:
// the verbatim pre-refactor STAGE 2-3 (helpers/legacy-rank.mjs) and the extracted
// function are run over thousands of random candidate sets and must agree row for row,
// in order. Seeded, so a failure is reproducible from the message alone.

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCandidates(rand) {
  const size = Math.floor(rand() * 21); // 0..20 — CANDIDATE_POOL_SIZE is 20
  const sources = 1 + Math.floor(rand() * 5);
  const headings = [null, "", "Plans", "Refunds", "Hours", "Contact", "Pricing > Pro", "FAQ"];
  const keywordStyle = rand();
  let distance = 0.2;
  return Array.from({ length: size }, (_, i) => {
    distance += rand() * 0.02;
    // Mix of: all zero (no keyword signal), small ties, plain numbers, and Postgres-style strings.
    const k = rand();
    const keywordRank =
      keywordStyle < 0.25 ? 0
      : k < 0.4 ? 0
      : k < 0.6 ? Math.floor(rand() * 3) / 10
      : k < 0.8 ? String(Math.round(rand() * 100) / 100)
      : rand();
    return {
      id: `r${i}`,
      sourceTitle: `Doc ${Math.floor(rand() * sources)}`,
      heading: headings[Math.floor(rand() * headings.length)],
      content: `content ${i}`,
      sourceUpdatedAt: new Date(2026, 0, 1 + Math.floor(rand() * 200)),
      distance,
      keywordRank,
    };
  });
}

test("rankCandidates === the pre-refactor stage 2-3 on 5,000 random candidate sets", () => {
  const SEED = 20261003;
  const rand = mulberry32(SEED);
  let nonTrivial = 0;
  for (let run = 0; run < 5000; run++) {
    const candidates = randomCandidates(rand);
    const topK = 1 + Math.floor(rand() * 8);
    const before = JSON.parse(JSON.stringify(candidates));

    const expected = legacyRank(candidates, topK);
    const actual = rankCandidates(candidates, topK);

    assert.deepEqual(actual, expected, `seed ${SEED}, run ${run}, topK ${topK}`);
    assert.deepEqual(JSON.parse(JSON.stringify(candidates)), before, "input untouched");
    if (expected.length > 1) nonTrivial++;
  }
  // Guard against the generator degenerating into trivial inputs and "passing" vacuously.
  assert.ok(nonTrivial > 3500, `only ${nonTrivial} of 5000 runs had 2+ results`);
});

test("the equivalence harness can fail: a deliberately different ranker is caught", () => {
  const rand = mulberry32(7);
  let differed = 0;
  for (let run = 0; run < 200; run++) {
    const candidates = randomCandidates(rand);
    const topK = 1 + Math.floor(rand() * 8);
    // "Ranker" that just takes the vector order — what retrieval did before hybrid + diversity.
    const naive = candidates.slice(0, topK).map(({ keywordRank: _k, ...rest }) => rest);
    try {
      assert.deepEqual(naive, legacyRank(candidates, topK));
    } catch {
      differed++;
    }
  }
  assert.ok(differed > 20, `harness is not sensitive enough: ${differed}/200 differed`);
});
