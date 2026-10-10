#!/usr/bin/env node
/**
 * KEYWORD-ONLY OFFLINE EVAL — how good is the keyword half of the hybrid ranking ON ITS OWN?
 *
 * ZERO embedding calls, zero model calls. It reads the chunks ALREADY STORED for the eval
 * tenant (the `test-docs/` corpus `eval:real` ingested) and ranks them with SQL full-text
 * search only — no vectors, no distance gate. For every question in eval-questions.mjs it
 * asks: by keyword score alone, does the expected document come first / in the top 3?
 *
 * Why this exists (§6.3): `plainto_tsquery` ANDs every word, so a full-sentence question
 * matches nothing and the keyword half contributes ~0. This measures that, and measures
 * the OR-style alternatives (src/lib/agent/keyword-query.js), without spending quota.
 *
 * WHAT IT CANNOT TELL YOU: how the change behaves INSIDE the hybrid pipeline (RRF, the
 * MAX_DISTANCE gate, off-topic rejection, diversity). Keyword score only RE-ORDERS chunks
 * vector search already admitted; this script has no vector search. Adoption needs the
 * integrated `npm run eval:real` — see CLAUDE.md §6.22 for the checklist.
 *
 * Usage:
 *   npm run eval:keyword                       # all variants, tenant __eval_real__
 *   EVAL_TENANT=other npm run eval:keyword
 *   npm run eval:keyword -- --json             # machine-readable
 *   npm run eval:keyword -- --verbose          # per-question misses for each variant
 *
 * Scoring. A document's keyword score is its BEST chunk's rank. Documents with score 0
 * are unranked (no signal), never "ranked last by luck". Ties are scored PESSIMISTICALLY
 * (the expected document ranks behind everything it ties with), so a variant cannot look
 * good by tying.
 *
 * Follow-up questions are scored on the raw message only: the conversation-aware rewrite
 * (§6.19) is a model call and is deliberately not run here. They are reported separately
 * and excluded from "overall", exactly like eval:real does.
 */
process.loadEnvFile(".env");
const { PrismaClient, Prisma } = await import("@prisma/client");
const { QUESTIONS } = await import("./eval-questions.mjs");
const { buildKeywordQuery } = await import("@/lib/agent/keyword-query");

const prisma = new PrismaClient();
const TENANT = process.env.EVAL_TENANT || "__eval_real__";
const JSON_OUT = process.argv.includes("--json");
const VERBOSE = process.argv.includes("--verbose");

const CONFIGS = ["english", "italian", "simple"];
/** The tsquery for one chunk config. Config names come from the fixed list above, never input. */
const tsq = (variant, cfg, question, orQuery) => {
  const c = Prisma.raw(`'${cfg}'`);
  if (variant.kind === "websearch") return Prisma.sql`websearch_to_tsquery(${c}, ${question})`;
  if (variant.kind === "or" && orQuery) return Prisma.sql`to_tsquery(${c}, ${orQuery})`;
  return Prisma.sql`plainto_tsquery(${c}, ${question})`; // "and", and the OR fallback when nothing but filler remained
};

const VARIANTS = [
  { name: "AND plainto (current)", kind: "and", norm: 0 },
  { name: "websearch_to_tsquery", kind: "websearch", norm: 0 },
  { name: "OR", kind: "or", norm: 0 },
  { name: "OR + norm 1 (1+log len)", kind: "or", norm: 1 },
  { name: "OR + norm 2 (len)", kind: "or", norm: 2 },
  { name: "OR + norm 8 (unique words)", kind: "or", norm: 8 },
];

/** Italian vs English question, by words that only Italian uses. Good enough to bucket 94 questions. */
const IT_MARKERS = /\b(quanto|quanti|quale|quali|qual|avete|vostra|vostre|vostri|vostro|dove|negozi|della|degli|delle|nel|nella|il|gli|costa|orari|ricetta|assistenza|periodo|politica|abbonamenti|piano|lo)\b/i;
const qLang = (q) => (IT_MARKERS.test(q) || /[àèéìòù]/i.test(q) ? "it" : "en");

const hasTenant = await prisma.$queryRaw`SELECT count(*)::int AS n FROM ai_engine.knowledge_chunks WHERE tenant_id = ${TENANT}`;
if (!hasTenant[0].n) {
  console.error(
    `No chunks stored for tenant "${TENANT}". The eval corpus is gone; re-create it with\n` +
      `  npm run eval:real      (spends ~55 embedding texts)\n` +
      `or point EVAL_TENANT at a tenant that has documents. The harness itself is ready.`
  );
  await prisma.$disconnect();
  process.exit(2);
}

const docLang = new Map(
  (await prisma.$queryRaw`
    SELECT s.title, bool_or(c.search_config = 'italian'::regconfig) AS it
    FROM ai_engine.knowledge_sources s JOIN ai_engine.knowledge_chunks c ON c.source_id = s.id
    WHERE s.tenant_id = ${TENANT} GROUP BY s.title`).map((r) => [r.title, r.it ? "italian" : "english"])
);

/** Per-chunk keyword ranks for one question under one variant. */
async function rank(variant, question) {
  const { tsquery } = buildKeywordQuery(question);
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT s.title AS doc, c.search_config::text AS cfg,
           ts_rank_cd(
             c.content_tsv,
             CASE c.search_config
               WHEN 'italian'::regconfig THEN ${tsq(variant, "italian", question, tsquery)}
               WHEN 'simple'::regconfig  THEN ${tsq(variant, "simple", question, tsquery)}
               ELSE ${tsq(variant, "english", question, tsquery)}
             END,
             ${variant.norm}::int
           ) AS r
    FROM ai_engine.knowledge_chunks c
    JOIN ai_engine.knowledge_sources s ON s.id = c.source_id
    WHERE c.tenant_id = ${TENANT}`);
  return rows.map((r) => ({ doc: r.doc, cfg: r.cfg, r: Number(r.r) }));
}

/** doc -> best chunk rank, only for docs with a positive score. */
const docScores = (rows) => {
  const m = new Map();
  for (const { doc, r } of rows) if (r > 0 && r > (m.get(doc) ?? 0)) m.set(doc, r);
  return m;
};
/** 1-based rank of the BEST of `targets`, ties counted against it; Infinity if none has signal. */
const rankOf = (scores, targets) => {
  let best = Infinity;
  for (const t of targets) {
    const s = scores.get(t);
    if (!s) continue;
    let ahead = 0;
    for (const [d, v] of scores) if (d !== t && v >= s) ahead++;
    best = Math.min(best, ahead + 1);
  }
  return best;
};

const scored = QUESTIONS.map((item) => {
  const isFollow = item.category === "followup" || item.category === "followup_offtopic";
  const targets = item.expectBoth ?? item.expectAny ?? (item.expect ? [item.expect] : null);
  return { ...item, lang: qLang(item.q), targets, isFollow };
});

const results = [];
for (const variant of VARIANTS) {
  const per = [];
  for (const item of scored) {
    const rows = await rank(variant, item.q);
    const scores = docScores(rows);
    const cfgSignal = {
      english: rows.some((x) => x.cfg === "english" && x.r > 0),
      italian: rows.some((x) => x.cfg === "italian" && x.r > 0),
    };
    let r1 = null;
    let r3 = null;
    if (item.targets) {
      if (item.expectBoth) {
        // a conflict question: BOTH sources must surface
        const ranks = item.expectBoth.map((t) => rankOf(scores, [t]));
        // two documents cannot both be first, so conflict has NO hit@1 — only "both in the top 3".
        r1 = Infinity;
        r3 = Math.max(...ranks) <= 3 ? 1 : Infinity;
      } else {
        const k = rankOf(scores, item.targets);
        r1 = k <= 1 ? 1 : Infinity;
        r3 = k <= 3 ? 1 : Infinity;
      }
    }
    const top = [...scores].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    per.push({ item, signal: scores.size > 0, cfgSignal, hit1: r1 === 1, hit3: r3 === 1, scored: Boolean(item.targets), top, topIsItalianDoc: top ? docLang.get(top) === "italian" : false });
  }
  results.push({ variant, per });
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%`.padStart(4) : "   -");
const summarise = (per) => {
  const s = per.filter((p) => p.scored);
  return { n: s.length, hit1: s.filter((p) => p.hit1).length, hit3: s.filter((p) => p.hit3).length, signal: s.filter((p) => p.signal).length };
};
const groups = {
  overall: (p) => p.scored && !p.item.isFollow && p.item.category !== "conflict",
};

const report = {};
for (const { variant, per } of results) {
  const cats = {};
  for (const p of per) {
    const key = p.item.category;
    (cats[key] ??= []).push(p);
  }
  const byCat = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, summarise(v)]));
  const overall = summarise(per.filter(groups.overall));
  const byLang = Object.fromEntries(
    ["en", "it"].map((l) => [l, summarise(per.filter((p) => groups.overall(p) && p.item.lang === l))])
  );
  const itQ = per.filter((p) => p.item.lang === "it" && p.signal && p.scored && !p.item.isFollow);
  const cross = {
    questions: itQ.length,
    topIsItalianDoc: itQ.filter((p) => p.topIsItalianDoc).length,
    hitOnItalianChunks: per.filter((p) => p.item.lang === "it" && p.cfgSignal.italian).length,
    hitOnEnglishChunks: per.filter((p) => p.item.lang === "it" && p.cfgSignal.english).length,
    itTotal: per.filter((p) => p.item.lang === "it").length,
  };
  const offTopic = per.filter((p) => p.item.category === "off_topic");
  report[variant.name] = { byCat, overall, byLang, cross, offTopicWithSignal: offTopic.filter((p) => p.signal).length, offTopicN: offTopic.length };
}

if (JSON_OUT) {
  console.log(JSON.stringify({ tenant: TENANT, report }, null, 2));
} else {
  const chunks = hasTenant[0].n;
  console.log(`\nKEYWORD-ONLY eval — tenant ${TENANT}: ${docLang.size} documents, ${chunks} chunks, ${QUESTIONS.length} questions. No vectors, no model calls.\n`);
  const cats = ["factual", "phrased_loosely", "cross_language", "generic_overview", "report_phrasings", "conflict", "followup"];
  const names = results.map((r) => r.variant.name);
  const w = 28;
  const row = (label, cells) => console.log(label.padEnd(w) + cells.join("  "));
  console.log("hit@1 / hit@3 / has-any-keyword-signal   (per variant)\n");
  row("", names.map((n) => n.slice(0, 22).padEnd(22)));
  for (const c of cats) {
    row(c + ` (n=${report[names[0]].byCat[c]?.n ?? 0})`, names.map((n) => {
      const s = report[n].byCat[c];
      return s ? `${pct(s.hit1, s.n)} /${pct(s.hit3, s.n)} /${pct(s.signal, s.n)}`.padEnd(22) : "".padEnd(22);
    }));
  }
  row("OVERALL (excl conflict/follow)", names.map((n) => { const s = report[n].overall; return `${pct(s.hit1, s.n)} /${pct(s.hit3, s.n)} /${pct(s.signal, s.n)}`.padEnd(22); }));
  for (const l of ["en", "it"]) {
    row(`  ${l} questions (n=${report[names[0]].byLang[l].n})`, names.map((n) => { const s = report[n].byLang[l]; return `${pct(s.hit1, s.n)} /${pct(s.hit3, s.n)} /${pct(s.signal, s.n)}`.padEnd(22); }));
  }
  console.log("\nItalian questions (cross-language incl.): keyword signal by CHUNK language, and where the top doc is the Italian one");
  row("", names.map((n) => n.slice(0, 22).padEnd(22)));
  row("hit on italian-config chunks", names.map((n) => `${report[n].cross.hitOnItalianChunks}/${report[n].cross.itTotal}`.padEnd(22)));
  row("hit on english-config chunks", names.map((n) => `${report[n].cross.hitOnEnglishChunks}/${report[n].cross.itTotal}`.padEnd(22)));
  row("top doc is the Italian doc", names.map((n) => `${report[n].cross.topIsItalianDoc}/${report[n].cross.questions}`.padEnd(22)));
  console.log("\nOff-topic questions that get ANY keyword score (informational: keyword can never ADMIT a chunk, §6.3):");
  row("", names.map((n) => `${report[n].offTopicWithSignal}/${report[n].offTopicN}`.padEnd(22)));
  console.log("\nOR query built for a few questions (keyword-query.js):");
  for (const q of ["How many practitioners can the ClinicHMS Growth plan support?", "Quanto costa il piano ClinicHMS Growth?", "what's your clinic software called", "who are you"]) {
    console.log(`  ${JSON.stringify(q)}\n    -> ${buildKeywordQuery(q).tsquery || "(nothing left: falls back to AND)"}`);
  }
}

if (VERBOSE) {
  for (const { variant, per } of results) {
    console.log(`\n── misses (hit@1) — ${variant.name} ──`);
    for (const p of per) if (p.scored && !p.item.isFollow && !p.hit1) console.log(`  [${p.item.category}] ${p.item.q}  -> top: ${p.top ?? "(no signal)"}`);
  }
}
await prisma.$disconnect();
