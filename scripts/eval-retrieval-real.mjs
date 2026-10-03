#!/usr/bin/env node
/**
 * REAL-PATH RETRIEVAL EVALUATION.
 *
 * `eval-retrieval.mjs` (npm run eval:retrieval) scores `retrieveWithoutThreshold`
 * — pure vector distance, no keyword re-rank, no document/heading diversity —
 * against three tiny single-topic fixture documents typed straight into the
 * typed-text path. That is not the retriever the agent runs. `respond.js` calls
 * `retrieveRelevantChunks`: threshold-gated, hybrid-RRF-re-ranked, and
 * diversity-selected across documents (§6.3). A change that helps or hurts THAT
 * pipeline — the diversity stage, the RRF constant, the candidate pool size —
 * can pass the old eval unchanged, because the old eval never calls it.
 *
 * This script fixes both gaps:
 *   1. It queries `/api/knowledge/search?...&real=1`, which calls
 *      `retrieveRelevantChunks` directly — the exact function the agent uses.
 *   2. It ingests the FULL `test-docs/` fixture pack (12 files: md, txt, csv,
 *      PDF, DOCX, a scanned/OCR PDF, an Italian FAQ, a deliberate cross-document
 *      price conflict, an off-topic recipe) through the REAL multipart upload
 *      path (`POST /api/knowledge`), not a shortcut.
 *
 * It does NOT replace `eval-retrieval.mjs` — that script is still a fast,
 * cheap sanity check with no ingestion cost worth keeping. This is the one
 * that actually gates the pipeline the agent runs.
 *
 * Usage:
 *   node scripts/eval-retrieval-real.mjs                    # run + compare to baseline
 *   node scripts/eval-retrieval-real.mjs --update-baseline  # accept current numbers as the new baseline
 *   node scripts/eval-retrieval-real.mjs --sweep            # threshold boundary, per category
 *   APP_URL=http://localhost:3000 node scripts/eval-retrieval-real.mjs
 *
 * Ingests into its own throwaway tenant; never touches real data.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The labelled question set lives in its own module, shared with eval-embedding-variants.mjs.
import { QUESTIONS } from "./eval-questions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "test-docs");
const BASELINE_PATH = path.join(__dirname, "eval-retrieval-real.baseline.json");

const APP = process.env.APP_URL || "http://localhost:3000";
const TENANT = process.env.EVAL_TENANT || "__eval_real__";
const SWEEP = process.argv.includes("--sweep");
const UPDATE_BASELINE = process.argv.includes("--update-baseline");
/** Skip re-uploading the corpus — it is already in the throwaway tenant from a
 *  previous run (ingest is a REPLACE, so this is only a cost saving, never a
 *  correctness difference). Every full ingest spends ~55 embedding calls
 *  against a free-tier daily cap (§8 limitation 3), which matters when
 *  comparing query strategies back to back. */
const SKIP_INGEST = process.argv.includes("--skip-ingest");
/** Which query strategy the FOLLOW-UP categories run under (§6.19). Only the
 *  follow-up items carry a conversation, so this changes nothing else. */
const STRATEGY_ARG = process.argv.find((a) => a.startsWith("--strategy="))?.split("=")[1];
const DEFAULT_STRATEGY = "rewrite"; // must match DEFAULT_QUERY_STRATEGY in src/lib/agent/query.js
const STRATEGY = STRATEGY_ARG ?? DEFAULT_STRATEGY;
const EXPLORATORY = STRATEGY !== DEFAULT_STRATEGY;
/** --keyword=or runs the CANDIDATE keyword query (retrieve.js USE_OR_KEYWORD_QUERY, off by
 *  default) through the whole pipeline and judges it against the saved baseline — READ-ONLY:
 *  a candidate run never saves, extends or updates the baseline (that describes what ships). */
const KEYWORD_ARG = process.argv.find((a) => a.startsWith("--keyword="))?.split("=")[1];
if (KEYWORD_ARG && !["and", "or"].includes(KEYWORD_ARG)) throw new Error("--keyword must be and|or");
const KEYWORD = KEYWORD_ARG; // undefined = whatever the server ships
/** Gap between conversation turns under the rewrite strategy — ~13 requests a
 *  minute, under the free tier's per-minute chat cap (see the pacing note at
 *  its use). */
const REWRITE_PACE_MS = 4500;
/** The eval gives the rewrite a long budget so it measures the strategy's QUALITY.
 *  The production budget is 3s (REWRITE_TIMEOUT_MS in query.js); how many calls
 *  would have blown it is counted and reported separately, as a latency finding,
 *  instead of being allowed to masquerade as a quality result. */
const EVAL_REWRITE_BUDGET_MS = 15000;
const PRODUCTION_REWRITE_BUDGET_MS = 3000;

/** A metric may drop this many percentage points below the stored baseline
 *  before a run is treated as a regression, not noise. Small enough that a
 *  genuine pipeline regression still trips it; large enough that one flipped
 *  borderline question (a distance a hair's width from MAX_DISTANCE) doesn't
 *  fail CI on its own. */
const TOLERANCE = 0.03;

/** The corpus. The real `test-docs/` fixture pack this project already
 *  maintains for manual black-box testing — reused here instead of a second,
 *  parallel fixture set that would inevitably drift from it. */
const FIXTURE_FILES = [
  "01-company-overview.md",
  "02-clinichms-pricing.pdf",
  "03-storepulse-pricing-plans.docx",
  "04-returns-and-refund-policy.txt",
  "05-availability-and-support-hours.md",
  "06-clinichms-faq.md",
  "07-storepulse-user-guide.pdf",
  "08-storepulse-price-list-conflict.txt",
  "09-off-topic-recipe.txt",
  "10-nyron-onboarding-scanned.pdf",
  "11-clinichms-faq-it.md",
  "12-storepulse-plans.csv",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(p, init) {
  const res = await fetch(`${APP}${p}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${p} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function ingestCorpus() {
  if (SKIP_INGEST) {
    const list = await api(`/api/knowledge?tenantId=${encodeURIComponent(TENANT)}`);
    const have = new Set(list.sources.filter((s) => s.status === "ready").map((s) => s.title));
    const missing = FIXTURE_FILES.filter((f) => !have.has(f));
    if (missing.length) {
      throw new Error(`--skip-ingest, but these fixtures are not ready in tenant ${TENANT}: ${missing.join(", ")}. Run once without --skip-ingest.`);
    }
    console.log("corpus already ingested — skipping (--skip-ingest)\n");
    return;
  }
  process.stdout.write("ingesting test-docs corpus (real upload path)…");
  for (const fileName of FIXTURE_FILES) {
    const buffer = readFileSync(path.join(FIXTURE_DIR, fileName));
    const form = new FormData();
    form.append("file", new Blob([buffer]), fileName);
    const res = await fetch(`${APP}/api/knowledge?tenantId=${encodeURIComponent(TENANT)}`, {
      method: "POST",
      body: form,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.jobs?.length) {
      throw new Error(`upload ${fileName} failed: ${res.status} ${JSON.stringify(body)}`);
    }
    process.stdout.write(".");
  }
  console.log(" queued");

  process.stdout.write("waiting for ingestion (OCR on the scanned PDF takes longest)…");
  for (let i = 0; i < 90; i++) {
    const status = await api(`/api/knowledge/jobs?tenantId=${encodeURIComponent(TENANT)}`);
    process.stdout.write(".");
    if (!status.active) {
      const failed = status.jobs.filter((j) => j.status === "failed");
      if (failed.length) {
        throw new Error(
          `${failed.length} ingestion job(s) failed: ` +
            failed.map((j) => `${j.title}: ${j.error}`).join("; ")
        );
      }
      console.log(" done\n");
      return;
    }
    await sleep(2000);
  }
  throw new Error("timed out waiting for ingestion jobs to finish");
}

/** The REAL path — retrieveRelevantChunks over HTTP, via ?real=1. Every result
 *  is already threshold-admitted, hybrid-re-ranked and diversity-selected. */
async function realSearch(query, topK = 5) {
  const body = await api(
    `/api/knowledge/search?tenantId=${encodeURIComponent(TENANT)}&q=${encodeURIComponent(query)}&topK=${topK}&real=1${KEYWORD ? `&keyword=${KEYWORD}` : ""}`
  );
  return body.results;
}

/** The CONVERSATION-AWARE real path — retrieveForTurn over HTTP (POST). Returns
 *  the kept results plus what was actually searched and how that was decided. */
async function turnSearch(item, topK = 5) {
  return api(`/api/knowledge/search?tenantId=${encodeURIComponent(TENANT)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: item.q, history: item.history, topK, strategy: STRATEGY, rewriteTimeoutMs: EVAL_REWRITE_BUDGET_MS, keyword: KEYWORD }),
  });
}

/** The cheap local trigger verdict — spends nothing (no embedding, no model). */
async function decide(q) {
  return api(`/api/knowledge/search?tenantId=${encodeURIComponent(TENANT)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q, decideOnly: true }),
  });
}

/** The raw path — pure vector, unfiltered. Only used for the threshold sweep,
 *  which needs every candidate's own distance regardless of rank. */
async function rawSearch(query, topK = 25) {
  const body = await api(
    `/api/knowledge/search?tenantId=${encodeURIComponent(TENANT)}&q=${encodeURIComponent(query)}&topK=${topK}`
  );
  return body.results;
}

function rankOf(results, title) {
  const idx = results.findIndex((r) => r.sourceTitle === title);
  return idx === -1 ? 0 : idx + 1;
}

function candidatesOf(row) {
  return row.expectAny ?? (row.expect ? [row.expect] : []);
}

function scoreSingleExpect(row) {
  let rank = 0;
  for (const title of candidatesOf(row)) {
    const r = rankOf(row.results, title);
    if (r > 0 && (rank === 0 || r < rank)) rank = r;
  }
  return {
    rank,
    hit1: rank === 1,
    hit3: rank >= 1 && rank <= 3,
    hit5: rank >= 1 && rank <= 5,
    mrr: rank >= 1 ? 1 / rank : 0,
  };
}

function scoreConflict(row) {
  const ranks = row.expectBoth.map((title) => rankOf(row.results, title));
  const bothPresent = ranks.every((r) => r > 0);
  const worstRank = bothPresent ? Math.max(...ranks) : 0;
  return { ranks, bothPresent, worstRank };
}

const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(0)}%`);
const num = (v) => (v === null || v === undefined ? "n/a" : v.toFixed(3));

async function runMainEval() {
  await ingestCorpus();

  const byCategory = new Map();

  console.log(
    `querying (real path, topK=5 — matches respond.js's MAX_CONTEXT_CHUNKS; follow-up strategy: ${STRATEGY})…`
  );
  for (const item of QUESTIONS) {
    let results;
    let turn = null;
    if (item.history) {
      turn = await turnSearch(item, 5);
      // A FAILED rewrite is a provider fault (a transient 503, a slow call past
      // the timeout — ~1 in 20 on the free tier, see retry.js), not evidence
      // about the strategy: the app fails soft and searches the raw message,
      // which is right for a customer and wrong for a measurement. Re-issue the
      // turn rather than score a fallback as if it were a rewrite. Still failing
      // after that, the run is reported INVALID below, never silently scored.
      for (let attempt = 1; attempt < 3 && turn.rewrite?.status === "failed"; attempt++) {
        turn = await turnSearch(item, 5);
      }
      results = turn.results;
      // PACING. The free tier caps chat requests per MINUTE as well as per day;
      // twenty rewrites fired back to back trip it, the provider's retry backoff
      // pushes a call past the 3s rewrite budget, and the turn times out. A real
      // call makes one rewrite every several seconds, so a burst measures the
      // rate limiter, not the strategy. Only the rewrite strategy spends chat
      // quota; raw and concat run at full speed.
      if (STRATEGY === "rewrite") await sleep(REWRITE_PACE_MS);
    } else {
      results = await realSearch(item.q, 5);
    }
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push({ ...item, results, turn });
    process.stdout.write(".");
  }
  console.log("\n");

  const categories = {};
  const overallRows = [];

  for (const [cat, rows] of byCategory) {
    // Both off-topic categories are scored the same way: nothing may be returned.
    if (cat === "off_topic" || cat === "followup_offtopic") {
      const leaked = rows.filter((r) => r.results.length > 0);
      categories[cat] = {
        n: rows.length,
        rejectionRate: (rows.length - leaked.length) / rows.length,
        leaked: leaked.map((r) => ({
          q: r.q,
          top: `${r.results[0].sourceTitle} @ ${r.results[0].distance.toFixed(3)}`,
          searched: r.turn?.searchQuery,
        })),
      };
      continue;
    }

    if (cat === "conflict") {
      const scored = rows.map((r) => ({ ...r, ...scoreConflict(r) }));
      categories[cat] = {
        n: rows.length,
        bothPresentRate: scored.filter((r) => r.bothPresent).length / scored.length,
        failures: scored
          .filter((r) => !r.bothPresent)
          .map((r) => ({
            q: r.q,
            expectBoth: r.expectBoth,
            ranks: r.ranks,
          })),
      };
      continue;
    }

    const scored = rows.map((r) => ({ ...r, ...scoreSingleExpect(r) }));
    // "overall" stays the four STANDALONE categories so it remains comparable
    // with every earlier baseline; follow-ups are reported on their own line.
    if (cat !== "followup" && cat !== "report_phrasings") overallRows.push(...scored);
    const n = scored.length;
    categories[cat] = {
      n,
      hit1: scored.filter((r) => r.hit1).length / n,
      hit3: scored.filter((r) => r.hit3).length / n,
      hit5: scored.filter((r) => r.hit5).length / n,
      mrr: scored.reduce((s, r) => s + r.mrr, 0) / n,
      misses: scored
        .filter((r) => r.rank === 0)
        .map((r) => ({
          q: r.q,
          expect: candidatesOf(r),
          best: r.results[0] ? `${r.results[0].sourceTitle} @ ${r.results[0].distance.toFixed(3)}` : "nothing",
          searched: r.turn?.searchQuery,
        })),
    };
  }

  const overall = {
    n: overallRows.length,
    hit1: overallRows.filter((r) => r.hit1).length / overallRows.length,
    hit3: overallRows.filter((r) => r.hit3).length / overallRows.length,
    mrr: overallRows.reduce((s, r) => s + r.mrr, 0) / overallRows.length,
  };

  // ── DIAGNOSTICS for the follow-up strategy (never gated, never baselined) ──
  const turnRows = [...byCategory.values()].flat().filter((r) => r.turn);
  const rewrites = turnRows.map((r) => r.turn.rewrite).filter(Boolean);
  const diagnostics = {
    strategy: STRATEGY,
    turns: turnRows.length,
    trigger: {
      heuristic: turnRows.filter((r) => r.turn.trigger === "heuristic").length,
      empty: turnRows.filter((r) => r.turn.trigger === "empty").length,
      none: turnRows.filter((r) => !r.turn.trigger).length,
    },
    rewriteCalls: rewrites.length,
    rewriteFailed: rewrites.filter((w) => w.status === "failed").length,
    rewriteErrors: turnRows
      .filter((r) => r.turn.rewrite?.status === "failed")
      .map((r) => `"${r.q}": ${r.turn.rewrite.error} (${r.turn.rewrite.ms}ms)`),
    rewriteOverProductionBudget: rewrites.filter((w) => (w.ms ?? 0) > PRODUCTION_REWRITE_BUDGET_MS).length,
    rewriteMaxMs: rewrites.length ? Math.max(...rewrites.map((w) => w.ms ?? 0)) : 0,
    rewriteAvgMs: rewrites.length ? Math.round(rewrites.reduce((s, w) => s + (w.ms ?? 0), 0) / rewrites.length) : 0,
    // Follow-up rows, for the per-question evidence table.
    table: turnRows.map((r) => ({
      category: r.category,
      q: r.q,
      searched: r.turn.searchQuery,
      trigger: r.turn.trigger,
      rewrite: r.turn.rewrite?.status ?? null,
      top: r.results[0] ? `${r.results[0].sourceTitle} @ ${r.results[0].distance.toFixed(3)}` : "nothing",
      hit: r.category === "followup" ? scoreSingleExpect(r).rank : null,
    })),
  };

  // How often does the cheap trigger fire on STANDALONE questions? Each firing
  // is a model call a phone call would not have needed. Free to measure.
  const standalone = QUESTIONS.filter((q) => !q.history);
  const fired = [];
  for (const item of standalone) {
    if ((await decide(item.q)).needsContext) fired.push(item.q);
  }
  diagnostics.standaloneTrigger = { n: standalone.length, fired };

  return { categories, overall, diagnostics };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function saveBaseline(data) {
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + "\n");
}

/** Only flags a DROP beyond TOLERANCE — an improvement never fails the gate. */
function compareToBaseline(current, baseline) {
  const regressions = [];
  const check = (label, cur, base) => {
    if (base === null || base === undefined || cur === null || cur === undefined) return;
    if (base - cur > TOLERANCE) regressions.push({ label, current: cur, baseline: base, drop: base - cur });
  };

  for (const cat of Object.keys(baseline.categories)) {
    const c = current.categories[cat];
    const b = baseline.categories[cat];
    if (!c || !b) continue;
    check(`${cat}.hit1`, c.hit1, b.hit1);
    check(`${cat}.hit3`, c.hit3, b.hit3);
    check(`${cat}.mrr`, c.mrr, b.mrr);
    check(`${cat}.rejectionRate`, c.rejectionRate, b.rejectionRate);
    check(`${cat}.bothPresentRate`, c.bothPresentRate, b.bothPresentRate);
  }
  check("overall.hit1", current.overall.hit1, baseline.overall.hit1);
  check("overall.hit3", current.overall.hit3, baseline.overall.hit3);
  check("overall.mrr", current.overall.mrr, baseline.overall.mrr);

  return regressions;
}

function printReport(result) {
  console.log("RETRIEVAL AT THRESHOLD 0.43 — REAL PATH (retrieveRelevantChunks: hybrid + diversity)\n");

  const order = ["factual", "phrased_loosely", "cross_language", "generic_overview", "report_phrasings"];
  for (const cat of order) {
    const c = result.categories[cat];
    if (!c) continue;
    console.log(`  [${cat}]  n=${c.n}`);
    console.log(`    hit@1 ${pct(c.hit1).padStart(5)}   hit@3 ${pct(c.hit3).padStart(5)}   hit@5 ${pct(c.hit5).padStart(5)}   MRR ${num(c.mrr)}`);
    if (c.misses.length) {
      for (const m of c.misses) {
        console.log(`      MISS  "${m.q}"  expected ${m.expect.join(" or ")}, best was ${m.best}`);
      }
    }
    console.log("");
  }

  console.log(`  [overall — factual + phrased_loosely + cross_language + generic_overview]  n=${result.overall.n}  (report_phrasings, off-topic, conflict and follow-ups are reported separately)`);
  console.log(`    hit@1 ${pct(result.overall.hit1).padStart(5)}   hit@3 ${pct(result.overall.hit3).padStart(5)}   MRR ${num(result.overall.mrr)}\n`);

  for (const cat of ["off_topic", "followup_offtopic"]) {
    const ot = result.categories[cat];
    if (!ot) continue;
    console.log(`  [${cat}]  n=${ot.n}  rejected ${pct(ot.rejectionRate)}`);
    for (const l of ot.leaked) {
      console.log(`      LEAK  "${l.q}"  →  ${l.top}${l.searched ? `   (searched: "${l.searched}")` : ""}`);
    }
    console.log("");
  }

  const fu = result.categories.followup;
  if (fu) {
    console.log(`  [followup — strategy: ${result.diagnostics.strategy}]  n=${fu.n}`);
    console.log(`    hit@1 ${pct(fu.hit1).padStart(5)}   hit@3 ${pct(fu.hit3).padStart(5)}   hit@5 ${pct(fu.hit5).padStart(5)}   MRR ${num(fu.mrr)}`);
    for (const m of fu.misses) {
      console.log(`      MISS  "${m.q}"  expected ${m.expect.join(" or ")}, best was ${m.best}  (searched: "${m.searched}")`);
    }
    console.log("");
  }

  const cf = result.categories.conflict;
  if (cf) {
    console.log(`  [conflict]  n=${cf.n}  both-sources-present ${pct(cf.bothPresentRate)}`);
    for (const f of cf.failures) {
      console.log(`      MISS  "${f.q}"  expected BOTH ${f.expectBoth.join(" + ")}, ranks were ${f.ranks.join(", ")} (0 = not returned)`);
    }
    console.log("");
  }

  // Strategy diagnostics — informational, never gated or baselined.
  const d = result.diagnostics;
  console.log(`  TURN DIAGNOSTICS (${d.turns} turns searched with conversation, strategy ${d.strategy})`);
  console.log(
    `    trigger fired: ${d.trigger.heuristic} by the cheap check, ${d.trigger.empty} by an empty first pass, ${d.trigger.none} not at all`
  );
  console.log(
    `    rewrite calls: ${d.rewriteCalls}  (${d.rewriteFailed} failed, avg ${d.rewriteAvgMs}ms, slowest ${d.rewriteMaxMs}ms; ${d.rewriteOverProductionBudget} over the 3s production budget — those would have fallen back to raw)`
  );
  console.log(
    `    cheap check on STANDALONE questions: fires on ${d.standaloneTrigger.fired.length}/${d.standaloneTrigger.n}` +
      ` — each would cost a needless model call mid-conversation`
  );
  for (const q of d.standaloneTrigger.fired) console.log(`      fires: "${q}"`);
  console.log("\n    question → what was actually searched → top result (rank of expected source)");
  for (const row of d.table) {
    const mark = row.category === "followup" ? (row.hit ? `✓ #${row.hit}` : "✗") : row.top === "nothing" ? "✓ nothing" : "✗ LEAK";
    console.log(`      [${mark}] (${row.trigger ?? "no trigger"}) "${row.q}"  →  "${row.searched}"  →  ${row.top}`);
  }
  console.log("");
}

async function main() {
  if (SWEEP) {
    await runSweep();
    return;
  }

  const result = await runMainEval();
  printReport(result);

  // An exploratory run (--strategy= other than the shipped default) compares
  // strategies; it must never overwrite or be judged against the baseline,
  // which describes the pipeline the agent actually runs.
  if (EXPLORATORY) {
    console.log(`  EXPLORATORY RUN (--strategy=${STRATEGY}) — baseline neither read nor written.`);
    return;
  }

  // A run whose rewrites FAILED did not test the strategy at all: the failed
  // ones silently searched the raw message instead (that is the fail-soft
  // behaviour), so the numbers would read as "rewrite doesn't help". Refuse to
  // judge or save them.
  if (result.diagnostics.rewriteFailed > 0) {
    console.log(
      `  INVALID RUN — ${result.diagnostics.rewriteFailed} rewrite call(s) failed (quota/timeout?). ` +
        "Those turns searched the raw message, so these numbers do not describe the rewrite strategy. " +
        "Baseline neither compared nor saved."
    );
    for (const e of result.diagnostics.rewriteErrors) console.log(`    failed: ${e}`);
    process.exit(1);
  }

  const baseline = loadBaseline();
  const { diagnostics: _diagnostics, ...persistable } = result;

  if (KEYWORD) {
    if (!baseline) {
      console.log("  --keyword needs a saved baseline to judge against; run the plain eval first.");
      process.exit(1);
    }
    const drops = compareToBaseline(result, baseline);
    console.log(`  CANDIDATE RUN (--keyword=${KEYWORD}) — judged against the saved baseline, baseline NOT written.`);
    for (const r of drops) console.log(`    REGRESSION ${r.label}: ${pct(r.current)} vs baseline ${pct(r.baseline)}  (down ${(r.drop * 100).toFixed(1)} pts)`);
    console.log(drops.length ? "\n  FAIL — do not adopt." : "\n  PASS — no regression beyond tolerance. Now read the checklist: cross_language, off_topic, report_phrasings (CLAUDE.md §6.22).");
    process.exit(drops.length ? 1 : 0);
  }

  if (baseline && UPDATE_BASELINE) {
    // Show what accepting the new numbers would change BEFORE overwriting —
    // an update that silently swallows a regression is how a baseline stops
    // meaning anything.
    const drops = compareToBaseline(result, baseline);
    console.log(
      drops.length
        ? `  Accepting these numbers as the new baseline. Metrics lower than the old one:\n` +
            drops.map((r) => `    ${r.label}: ${pct(r.current)} vs ${pct(r.baseline)}`).join("\n")
        : "  No metric is lower than the old baseline."
    );
  }

  if (!baseline || UPDATE_BASELINE) {
    saveBaseline(persistable);
    console.log(
      baseline
        ? `  Baseline UPDATED at ${path.relative(process.cwd(), BASELINE_PATH)} (--update-baseline was passed).`
        : `  No baseline found — this run WAS SAVED as the initial baseline at ${path.relative(process.cwd(), BASELINE_PATH)}.`
    );
    console.log("\n  PASS — nothing to regress against yet.");
    return;
  }

  const regressions = compareToBaseline(result, baseline);

  // Categories the baseline has never seen (a newly added question group) are
  // ADDED to it, so the next run can regress against them. Categories already
  // in it are never touched here — those change only through --update-baseline.
  const added = Object.keys(persistable.categories).filter((c) => !baseline.categories[c]);
  if (!regressions.length && added.length) {
    saveBaseline({
      ...baseline,
      categories: {
        ...baseline.categories,
        ...Object.fromEntries(added.map((c) => [c, persistable.categories[c]])),
      },
    });
    console.log(`  Baseline EXTENDED with new categories: ${added.join(", ")} (existing ones untouched).`);
  }

  if (regressions.length) {
    console.log(`  REGRESSIONS (> ${(TOLERANCE * 100).toFixed(0)} point tolerance vs. baseline):`);
    for (const r of regressions) {
      console.log(`    ${r.label}: ${pct(r.current)} vs baseline ${pct(r.baseline)}  (down ${(r.drop * 100).toFixed(1)} pts)`);
    }
    console.log("\n  FAIL");
    process.exit(1);
  }

  console.log(`  No regression beyond ${(TOLERANCE * 100).toFixed(0)} points vs. the stored baseline.`);
  console.log("\n  PASS");
}

/**
 * THRESHOLD SWEEP, PER CATEGORY.
 *
 * The original sweep (eval-retrieval.mjs --sweep) reports ONE boundary across
 * a 19-question single-topic fixture. That hides exactly the failure mode
 * this whole script exists to surface: some CATEGORIES of real phone-caller
 * question sit much closer to the off-topic boundary than others — a generic
 * "tell me about your company" opener is nowhere near as confidently
 * on-topic, distance-wise, as "how much is ClinicHMS Growth". Reporting one
 * number averages that gap away.
 */
async function runSweep() {
  await ingestCorpus();

  console.log("querying (raw, unfiltered, topK=25) for sweep…");
  const rows = [];
  for (const item of QUESTIONS) {
    // Conversation items have no standalone distance to calibrate a threshold on.
    if (item.history || item.category === "off_topic") continue;
    const results = await rawSearch(item.q, 25);
    rows.push({ ...item, results });
    process.stdout.write(".");
  }
  const offTopicRows = [];
  for (const item of QUESTIONS.filter((q) => q.category === "off_topic")) {
    const results = await rawSearch(item.q, 25);
    offTopicRows.push({ ...item, results });
    process.stdout.write(".");
  }
  console.log("\n");

  /** The distance that actually has to clear MAX_DISTANCE for this row to
   *  count as answered: the BEST candidate for an expect/expectAny row (any
   *  one clearing is enough), or the WORSE of the two for an expectBoth row
   *  (both must clear, so the harder of the two is what gates it). */
  function neededDistance(row) {
    if (row.expectBoth) {
      const dists = row.expectBoth.map((title) => {
        const hit = row.results.find((r) => r.sourceTitle === title);
        return hit ? hit.distance : Infinity;
      });
      return Math.max(...dists);
    }
    const dists = candidatesOf(row).map((title) => {
      const hit = row.results.find((r) => r.sourceTitle === title);
      return hit ? hit.distance : Infinity;
    });
    return Math.min(...dists);
  }

  const bestOffTopic = Math.min(...offTopicRows.map((r) => (r.results[0] ? r.results[0].distance : Infinity)));

  console.log("THRESHOLD SWEEP — per category boundary\n");
  console.log(`  closest off-topic question (must be REJECTED) : ${bestOffTopic.toFixed(3)}\n`);

  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row);
  }

  console.log("  category            hardest question that must be ANSWERED   vs. off-topic boundary");
  console.log("  ───────────────────────────────────────────────────────────────────────────────────");
  let anyOverlap = false;
  for (const [cat, catRows] of byCategory) {
    const worst = Math.max(...catRows.map(neededDistance));
    const overlaps = worst >= bestOffTopic;
    anyOverlap = anyOverlap || overlaps;
    const verdict = overlaps
      ? "⚠ OVERLAPS — no threshold separates them"
      : `clear, gap ${(bestOffTopic - worst).toFixed(3)}`;
    console.log(`  ${cat.padEnd(18)}  ${worst.toFixed(3).padStart(8)}                              ${verdict}`);
  }
  console.log("");

  if (anyOverlap) {
    console.log(
      "  ⚠ At least one category OVERLAPS the off-topic boundary at the current\n" +
        "    embedding/chunking pipeline. No single MAX_DISTANCE value can both answer\n" +
        "    every question in that category and reject every off-topic one — the fix\n" +
        "    is better chunking, query rewriting, or accepting that category's current\n" +
        "    failure rate, not moving the threshold (§6.3).\n"
    );
  } else {
    const worstOverall = Math.max(...rows.map(neededDistance));
    const midpoint = (worstOverall + bestOffTopic) / 2;
    console.log(
      `  hardest question overall that SHOULD be answered : ${worstOverall.toFixed(3)}\n` +
        `  gap                                               : ${(bestOffTopic - worstOverall).toFixed(3)}\n` +
        `  Suggested MAX_DISTANCE (midpoint)                 : ${midpoint.toFixed(2)}\n`
    );
  }

  // Classic aggregate table (dist / hit@1 / hit@3 / MRR / off-topic-rejected)
  // across every single-expect / expectAny row (conflict rows excluded — "rank"
  // isn't a well-defined idea when two sources must BOTH appear).
  const singleExpectRows = rows.filter((r) => !r.expectBoth);
  console.log("  CLASSIC AGGREGATE TABLE (single-expect categories only)");
  console.log("  dist   hit@1  hit@3   MRR   off-topic rejected");
  console.log("  ─────────────────────────────────────────────");
  for (const threshold of [0.3, 0.35, 0.4, 0.42, 0.45, 0.48, 0.5, 0.55, 0.6, 0.7, 2]) {
    let hits1 = 0;
    let hits3 = 0;
    let mrrTotal = 0;
    for (const row of singleExpectRows) {
      const kept = row.results.filter((r) => r.distance <= threshold);
      let rank = 0;
      for (const title of candidatesOf(row)) {
        const idx = kept.findIndex((r) => r.sourceTitle === title);
        if (idx !== -1 && (rank === 0 || idx + 1 < rank)) rank = idx + 1;
      }
      if (rank === 1) hits1++;
      if (rank >= 1 && rank <= 3) hits3++;
      mrrTotal += rank >= 1 ? 1 / rank : 0;
    }
    let rejected = 0;
    for (const row of offTopicRows) {
      const kept = row.results.filter((r) => r.distance <= threshold);
      if (kept.length === 0) rejected++;
    }
    console.log(
      `  ${threshold.toFixed(2)}   ${pct(hits1 / singleExpectRows.length).padStart(4)}   ${pct(hits3 / singleExpectRows.length).padStart(4)}  ` +
        `${(mrrTotal / singleExpectRows.length).toFixed(2)}   ${pct(rejected / offTopicRows.length).padStart(4)}`
    );
  }
}

main().catch((err) => {
  console.error("\neval failed:", err.message);
  process.exit(1);
});
