#!/usr/bin/env node
/**
 * WHICH EMBEDDING SCHEME? — measured before any row is re-embedded.
 *
 * Anything that changes what is embedded changes every stored vector and forces
 * a re-embed plus a re-measured MAX_DISTANCE (src/lib/agent/embed-scheme.js, §6.3),
 * and the free quota is ~1000 TEXTS a day. So the candidates are compared HERE,
 * in memory — nothing is written to the database — and only a winner is adopted
 * and re-embedded, once.
 *
 * Variants (chunks are the eval corpus tenant's stored documents, rebuilt through
 * the real chunker):
 *   V0  current   as stored — heading path only, no task types          (free: reads the DB)
 *   V1  title     document title prefixed into embedText
 *   V2  taskType  RETRIEVAL_DOCUMENT for chunks, RETRIEVAL_QUERY for questions
 *   V3  both
 *
 * ⚠️ DO NOT COMPARE DISTANCES ACROSS VARIANTS AT A FIXED THRESHOLD. A taskType can
 * move every distance (that is partly what it is for), so "within 0.43" means
 * something different in each. What is comparable is SEPARATION: each variant gets
 * its own best threshold — the midpoint between its hardest must-answer question
 * and its closest off-topic one, exactly how MAX_DISTANCE was set (§6.3) — and is
 * judged by how much it then lets through, and how much it keeps out.
 *
 * Pure vector only (no keyword re-rank, no diversity): this PICKS a scheme; the
 * arbiter after re-embedding is `npm run eval:real`.
 *
 * Resumable: every embedding is cached on disk (node_modules/.cache), so a quota
 * stop loses nothing — run it again after the quota resets and it continues.
 *
 * Usage:
 *   npm run eval:embedding-variants -- --dry-run     # how many texts it still needs
 *   npm run eval:embedding-variants                  # all variants
 *   npm run eval:embedding-variants -- --variants=V0,V2
 *   --tenant=__eval_real__   (the corpus; default)   --pace-ms=600
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { GoogleGenAI } from "@google/genai";
import { QUESTIONS } from "./eval-questions.mjs";
import { chunkDocument } from "@/lib/agent/chunk";

process.loadEnvFile?.(".env");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DRY = process.argv.includes("--dry-run");
const TENANT = arg("tenant") ?? "__eval_real__";
const PACE_MS = Number(arg("pace-ms") ?? 600);
const BATCH = 16;
const CURRENT_GATE = 0.43; // retrieve.js MAX_DISTANCE — shown for reference only

const VARIANTS = {
  V0: { label: "current (as stored)", title: false, taskType: false, stored: true },
  V1: { label: "title prefix", title: true, taskType: false },
  V2: { label: "taskType", title: false, taskType: true },
  V3: { label: "title + taskType", title: true, taskType: true },
};
const chosen = (arg("variants") ?? Object.keys(VARIANTS).join(",")).split(",");

const CACHE_PATH = path.resolve(process.env.EMBED_VARIANTS_CACHE ?? "node_modules/.cache/embedding-variants.json");
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};
const saveCache = () => {
  mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
};
const keyOf = (taskType, text) => JSON.stringify([taskType, text]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prisma = new PrismaClient();

/** Embed whatever is not cached yet, in batches, for one taskType (or null).
 *  Returns how many texts that took (or, in a dry run, would take). */
const counted = new Set(); // dry run: a text two variants share is still one embedding
async function ensureEmbedded(texts, taskType) {
  const todo = [...new Set(texts)].filter((t) => !cache[keyOf(taskType, t)]);
  if (DRY) {
    const fresh = todo.filter((t) => !counted.has(keyOf(taskType, t)));
    fresh.forEach((t) => counted.add(keyOf(taskType, t)));
    return fresh.length;
  }
  if (!todo.length) return 0;
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await ai.models.embedContent({
          model: "gemini-embedding-001",
          contents: batch,
          config: { outputDimensionality: 768, ...(taskType ? { taskType } : {}) },
        });
        res.embeddings.forEach((e, j) => (cache[keyOf(taskType, batch[j])] = e.values));
        saveCache();
        break;
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (/PerDay/i.test(msg)) {
          saveCache();
          console.log(`\n✗ daily embedding quota exhausted — ${Object.keys(cache).length} vectors cached. Run again after it resets.`);
          process.exitCode = 3;
          throw new Error("quota");
        }
        if (/RESOURCE_EXHAUSTED|429/.test(msg) && attempt <= 4) {
          console.log("  … rate limited, waiting 65s");
          await sleep(65_000);
          continue;
        }
        throw err;
      }
    }
    await sleep(PACE_MS);
  }
  return todo.length;
}

const cosineDistance = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - dot / Math.sqrt(na * nb);
};

const standalone = QUESTIONS.filter((q) => !q.history);
const expected = (q) => (q.expect ? [q.expect] : q.expectAny ?? q.expectBoth ?? null);
// Categories whose questions the system is EXPECTED to answer today — the set the
// threshold has to clear. generic_overview / phrased_loosely are what we are trying
// to improve, so they are measured AGAINST the threshold the rest sets, not used to set it.
const MUST_ANSWER = new Set(["factual", "cross_language", "conflict"]);

async function main() {
  const sources = await prisma.knowledgeSource.findMany({
    where: { tenantId: TENANT, status: "ready" },
    select: { title: true, content: true },
  });
  if (!sources.length) throw new Error(`no documents in tenant ${TENANT} — run npm run eval:real once first`);
  const stored = await prisma.$queryRaw`
    SELECT source_title AS "sourceTitle", heading, content, embedding::text AS vec
    FROM ai_engine.knowledge_chunks WHERE tenant_id = ${TENANT}`;

  const queryTexts = standalone.map((q) => q.q);
  const results = {};
  let needed = 0;

  for (const name of chosen) {
    const v = VARIANTS[name];
    if (!v) throw new Error(`unknown variant ${name}`);

    let chunks;
    if (v.stored) {
      chunks = stored.map((r) => ({ sourceTitle: r.sourceTitle, vector: JSON.parse(r.vec) }));
    } else {
      const items = sources.flatMap((s) =>
        chunkDocument(s.content, { title: v.title ? s.title : undefined }).map((c) => ({
          sourceTitle: s.title,
          text: c.embedText,
        }))
      );
      needed += await ensureEmbedded(items.map((i) => i.text), v.taskType ? "RETRIEVAL_DOCUMENT" : null);
      chunks = DRY ? [] : items.map((i) => ({ sourceTitle: i.sourceTitle, vector: cache[keyOf(v.taskType ? "RETRIEVAL_DOCUMENT" : null, i.text)] }));
    }

    const qTask = v.taskType ? "RETRIEVAL_QUERY" : null;
    needed += await ensureEmbedded(queryTexts, qTask);
    if (DRY) continue;

    const rows = standalone.map((q) => {
      const qv = cache[keyOf(qTask, q.q)];
      const ranked = chunks.map((c) => ({ title: c.sourceTitle, d: cosineDistance(qv, c.vector) })).sort((a, b) => a.d - b.d);
      const exp = expected(q);
      const bestExpected = exp ? ranked.find((r) => exp.includes(r.title))?.d ?? Infinity : null;
      return { q, exp, nearest: ranked[0], bestExpected, top1: exp ? exp.includes(ranked[0].title) : null };
    });
    results[name] = rows;
  }

  if (DRY) {
    console.log(`dry run — ${needed} embedding text(s) still needed for ${chosen.join(", ")} (the rest are cached).`);
    return;
  }

  // ---- report -------------------------------------------------------------
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");
  console.log(`corpus: ${TENANT}, ${standalone.length} standalone questions (pure-vector, each variant at its OWN threshold)\n`);
  console.log(
    "variant".padEnd(24) + "hardest ans".padStart(12) + "closest off".padStart(12) + "gap".padStart(8) + "threshold".padStart(11) +
      "overview kept".padStart(15) + "loose kept".padStart(12) + "off leaked".padStart(12) + "fact top1".padStart(11) + "xlang top1".padStart(12)
  );
  for (const name of chosen) {
    const rows = results[name];
    const must = rows.filter((r) => MUST_ANSWER.has(r.q.category) && r.exp);
    const off = rows.filter((r) => r.q.category === "off_topic");
    const hardest = Math.max(...must.map((r) => r.bestExpected));
    const closestOff = Math.min(...off.map((r) => r.nearest.d));
    const overlap = hardest >= closestOff;
    const threshold = (hardest + closestOff) / 2;
    const cat = (c) => rows.filter((r) => r.q.category === c && r.exp);
    const kept = (c) => cat(c).filter((r) => r.bestExpected <= threshold).length;
    const top1 = (c) => cat(c).filter((r) => r.top1).length;
    console.log(
      `${name} ${VARIANTS[name].label}`.padEnd(24) +
        hardest.toFixed(3).padStart(12) + closestOff.toFixed(3).padStart(12) +
        (overlap ? "OVERLAP" : (closestOff - hardest).toFixed(3)).padStart(8) +
        threshold.toFixed(3).padStart(11) +
        `${kept("generic_overview")}/${cat("generic_overview").length}`.padStart(15) +
        `${kept("phrased_loosely")}/${cat("phrased_loosely").length}`.padStart(12) +
        `${off.filter((r) => r.nearest.d <= threshold).length}/${off.length}`.padStart(12) +
        pct(top1("factual"), cat("factual").length).padStart(11) +
        pct(top1("cross_language"), cat("cross_language").length).padStart(12)
    );
  }
  console.log(
    `\nhardest ans  = farthest best-chunk among factual + cross_language + conflict (must be kept)\n` +
      `closest off  = nearest chunk of the closest off-topic question (must be rejected)\n` +
      `threshold    = their midpoint — what MAX_DISTANCE would be for that scheme (today: ${CURRENT_GATE})\n` +
      `overview/loose kept = questions the scheme would answer at THAT threshold; off leaked = off-topic it would let through\n` +
      `A scheme is only a candidate if its gap is not smaller than V0's, off leaked is 0, and top-1 does not fall.\n`
  );

  const first = chosen[0];
  console.log("generic_overview, per question (best distance to the expected document):");
  for (const q of standalone.filter((x) => x.category === "generic_overview")) {
    console.log("  " + q.q.padEnd(42) + chosen.map((n) => `${n} ${results[n].find((r) => r.q === q).bestExpected.toFixed(3)}`).join("   "));
  }
  void first;
}

main()
  .catch((err) => {
    if (err.message !== "quota") { console.error("eval-embedding-variants failed:", err); process.exitCode = 1; }
  })
  .finally(() => prisma.$disconnect());
