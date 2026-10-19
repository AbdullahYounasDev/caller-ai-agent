#!/usr/bin/env node
/**
 * RETRIEVAL EVALUATION.
 *
 * Answers the question you otherwise cannot answer: did that change make
 * retrieval better or worse?
 *
 * Chunking strategy, chunk size, the embedding model and the relevance
 * threshold all move retrieval quality in ways that are invisible from a few
 * manual questions — you try three, they look fine, and the regression shows up
 * as a customer being told the wrong price. This measures it instead.
 *
 * WHAT IT MEASURES
 *   hit@k        did the RIGHT document appear in the top k?
 *   MRR          how high did it rank? (1.0 = always first)
 *   rejection    off-topic questions that correctly returned NOTHING
 *   distances    the actual numbers, so the threshold can be set by evidence
 *
 * The off-topic cases matter as much as the answerable ones. A threshold tuned
 * only on questions that HAVE answers will happily be set too loose, and the
 * agent starts answering questions about car insurance from a dental price list.
 *
 * Usage:
 *   node scripts/eval-retrieval.mjs                 # run against the fixture
 *   node scripts/eval-retrieval.mjs --sweep         # try a range of thresholds
 *   APP_URL=http://localhost:3000 node scripts/eval-retrieval.mjs
 *
 * It ingests into its own throwaway tenant, so it never touches real data.
 */

const APP = process.env.APP_URL || "http://localhost:3000";
const TENANT = process.env.EVAL_TENANT || "__eval__";
const SWEEP = process.argv.includes("--sweep");

/** The corpus. Deliberately shaped like a real small business's documents:
 *  headings, a price table, a policy in prose, and hours. */
const DOCUMENTS = [
  {
    title: "eval-pricing.md",
    text: `# Pricing

## Routine care
A routine checkup and clean costs 80 euros. This includes a scale and polish.
Children under 12 are seen free of charge.

## Cosmetic
Teeth whitening costs 250 euros for a full course.
Veneers start at 600 euros per tooth.

## Emergency
Emergency root canal treatment is 450 euros.
Same-day emergency appointments are available before 10am on weekdays.`,
  },
  {
    title: "eval-hours.md",
    text: `# Opening hours

We are open Monday to Friday from 9am to 6pm.
On Saturday we are open from 9am to 1pm.
We are closed on Sundays and public holidays.

# Location

Our clinic is at 14 Via Roma, Milan.
There is paid parking in the square directly opposite.`,
  },
  {
    title: "eval-policies.md",
    text: `# Cancellation policy

Appointments cancelled with less than 24 hours notice are charged at half the
treatment price. Cancellations made more than 24 hours in advance are free.

# Payment

We accept cash and all major cards. We do not accept cheques.
Payment plans are available for treatments over 500 euros.

# Our team

Our lead dentist is Dr. Elena Ricci, who speaks Urdu and English.`,
  },
];

/** Questions with a known correct document. */
const ANSWERABLE = [
  { q: "How much is a checkup?", expect: "eval-pricing.md" },
  { q: "What does teeth whitening cost?", expect: "eval-pricing.md" },
  { q: "Is it free for kids?", expect: "eval-pricing.md" },
  { q: "How much for an emergency root canal?", expect: "eval-pricing.md" },
  { q: "What time do you close on Saturday?", expect: "eval-hours.md" },
  { q: "Are you open on Sunday?", expect: "eval-hours.md" },
  { q: "Where are you located?", expect: "eval-hours.md" },
  { q: "Is there parking nearby?", expect: "eval-hours.md" },
  { q: "What happens if I cancel late?", expect: "eval-policies.md" },
  { q: "Can I pay by card?", expect: "eval-policies.md" },
  { q: "Do you offer payment plans?", expect: "eval-policies.md" },
  { q: "Who is the lead dentist?", expect: "eval-policies.md" },
  // Cross-language: the corpus is English, the question is in Urdu. This is the case that
  // breaks naive setups — a Pakistani caller asking about a price list written in English.
  { q: "معائنے کی فیس کتنی ہے؟", expect: "eval-pricing.md" },
  { q: "ہفتے کے دن آپ کتنے بجے بند ہوتے ہیں؟", expect: "eval-hours.md" },
];

/** Questions this business genuinely cannot answer. Retrieval SHOULD return
 *  nothing — anything it returns is material the agent may then answer from. */
const OFF_TOPIC = [
  "What is the capital of France?",
  "Can you help me renew my car insurance?",
  "What are your flight change fees?",
  "How do I reset my email password?",
  "Do you sell mobile phone contracts?",
];

async function api(path, init) {
  const res = await fetch(`${APP}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${body?.error ?? ""}`);
  return body;
}

async function ingestFixture() {
  process.stdout.write("ingesting fixture…");
  for (const doc of DOCUMENTS) {
    await api(`/api/knowledge?tenantId=${encodeURIComponent(TENANT)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    process.stdout.write(".");
  }
  console.log(" done\n");
}

/** Retrieval is exercised through the debug endpoint, which returns distances
 *  and applies no threshold — so one run can be scored at any threshold. */
async function search(query) {
  const body = await api(
    `/api/knowledge/search?tenantId=${encodeURIComponent(TENANT)}&q=${encodeURIComponent(query)}&topK=5`
  );
  return body.results;
}

function score(rows, threshold) {
  let hits1 = 0;
  let hits3 = 0;
  let hits5 = 0;
  let mrrTotal = 0;
  const misses = [];

  for (const { question, expect, results } of rows) {
    const kept = results.filter((r) => r.distance <= threshold);
    const rank = kept.findIndex((r) => r.sourceTitle === expect) + 1;

    if (rank === 1) hits1++;
    if (rank >= 1 && rank <= 3) hits3++;
    if (rank >= 1 && rank <= 5) hits5++;
    mrrTotal += rank >= 1 ? 1 / rank : 0;
    if (rank === 0) {
      misses.push({
        question,
        expect,
        best: results[0] ? `${results[0].sourceTitle} @ ${results[0].distance.toFixed(3)}` : "nothing",
      });
    }
  }

  const n = rows.length;
  return {
    hit1: hits1 / n,
    hit3: hits3 / n,
    hit5: hits5 / n,
    mrr: mrrTotal / n,
    misses,
  };
}

function scoreRejection(rows, threshold) {
  let rejected = 0;
  const leaked = [];
  for (const { question, results } of rows) {
    const kept = results.filter((r) => r.distance <= threshold);
    if (kept.length === 0) rejected++;
    else leaked.push({ question, top: `${kept[0].sourceTitle} @ ${kept[0].distance.toFixed(3)}` });
  }
  return { rate: rejected / rows.length, leaked };
}

const pct = (v) => `${(v * 100).toFixed(0)}%`;

async function main() {
  await ingestFixture();

  console.log("running queries…");
  const answerable = [];
  for (const { q, expect } of ANSWERABLE) {
    answerable.push({ question: q, expect, results: await search(q) });
    process.stdout.write(".");
  }
  const offTopic = [];
  for (const q of OFF_TOPIC) {
    offTopic.push({ question: q, results: await search(q) });
    process.stdout.write(".");
  }
  console.log("\n");

  if (SWEEP) {
    console.log("THRESHOLD SWEEP");
    console.log("  dist   hit@1  hit@3   MRR   off-topic rejected");
    console.log("  ─────────────────────────────────────────────");
    for (const threshold of [0.3, 0.35, 0.4, 0.42, 0.45, 0.48, 0.5, 0.55, 0.6, 0.7, 2]) {
      const s = score(answerable, threshold);
      const r = scoreRejection(offTopic, threshold);
      console.log(
        `  ${threshold.toFixed(2)}   ${pct(s.hit1).padStart(4)}   ${pct(s.hit3).padStart(4)}  ` +
          `${s.mrr.toFixed(2)}   ${pct(r.rate).padStart(4)}`
      );
    }

    // THE ACTUAL DECISION DATA. A sweep table shows where things break; these
    // two numbers show WHY, and how much room there is between them.
    //
    // The threshold has to sit above every question that deserves an answer and
    // below every question that does not. If those two overlap, no threshold
    // can separate them and the fix is better chunking or a better embedding
    // model — not a different number here.
    const worstAnswerable = Math.max(
      ...answerable.map((row) => {
        const hit = row.results.find((r) => r.sourceTitle === row.expect);
        return hit ? hit.distance : Infinity;
      })
    );
    const bestOffTopic = Math.min(
      ...offTopic.map((row) => (row.results[0] ? row.results[0].distance : Infinity))
    );

    console.log("\n  BOUNDARY");
    console.log(`    hardest question that SHOULD be answered : ${worstAnswerable.toFixed(3)}`);
    console.log(`    closest question that should NOT be      : ${bestOffTopic.toFixed(3)}`);

    if (worstAnswerable >= bestOffTopic) {
      console.log(
        "\n    ⚠ THESE OVERLAP. No threshold separates them — some off-topic question\n" +
          "      looks closer than a real one. Improve chunking or embeddings; do not\n" +
          "      paper over it by moving the threshold.\n"
      );
    } else {
      const midpoint = (worstAnswerable + bestOffTopic) / 2;
      console.log(
        `    gap                                      : ${(bestOffTopic - worstAnswerable).toFixed(3)}\n` +
          `\n    Suggested MAX_DISTANCE (midpoint): ${midpoint.toFixed(2)}\n` +
          "    Set it in src/lib/agent/retrieve.js.\n"
      );
    }
    return;
  }

  // Read the threshold the app actually uses, so the report describes reality.
  const { threshold } = await api(`/api/knowledge/search?tenantId=${encodeURIComponent(TENANT)}&q=x&meta=1`);
  const s = score(answerable, threshold);
  const r = scoreRejection(offTopic, threshold);

  console.log(`RETRIEVAL AT THRESHOLD ${threshold}`);
  console.log(`  answerable questions : ${answerable.length}`);
  console.log(`  hit@1                : ${pct(s.hit1)}`);
  console.log(`  hit@3                : ${pct(s.hit3)}`);
  console.log(`  hit@5                : ${pct(s.hit5)}`);
  console.log(`  MRR                  : ${s.mrr.toFixed(3)}`);
  console.log(`  off-topic rejected   : ${pct(r.rate)}  (${offTopic.length} questions)`);

  if (s.misses.length) {
    console.log("\n  MISSED — expected document not retrieved:");
    for (const m of s.misses) {
      console.log(`    "${m.question}"  expected ${m.expect}, best was ${m.best}`);
    }
  }
  if (r.leaked.length) {
    console.log("\n  LEAKED — off-topic question that still got material:");
    for (const l of r.leaked) console.log(`    "${l.question}"  →  ${l.top}`);
  }

  // A regression gate, so this can run in CI rather than being read by eye.
  const ok = s.hit3 >= 0.9 && r.rate >= 0.8;
  console.log(`\n  ${ok ? "PASS" : "FAIL"} — gate: hit@3 ≥ 90%, off-topic rejection ≥ 80%`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\neval failed:", err.message);
  process.exit(1);
});
