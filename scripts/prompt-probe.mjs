#!/usr/bin/env node
/**
 * PROMPT PROBE (npm run prompt:probe) — the REAL prompt (prompt.js) against the REAL chat model, N samples per question,
 * every reply judged by a rule (scripts/prompt-judges.mjs). The tool that measured the three fixes of CLAUDE.md §6.24
 * "Found on those calls" (an invented business description 15/24 → 0/24, no over-refusal 18/18, a "First," opener
 * 6/18 → 0/18). Use it before and after ANY change to prompt.js wording, and keep the numbers next to the change.
 *
 * Why this exists next to the unit tests: tests/prompt.test.mjs pins the TEXT of the prompt; only a model can say
 * whether the text works. One sample of a non-deterministic model proves nothing, so the default is six per question.
 *
 * What it does and does not do:
 *  - No retrieval and no embeddings: grounded cases take their passages straight from the stored chunks (a heading
 *    pattern per question), so it spends CHAT quota only — about N × questions model calls per case (scarce on the
 *    free tiers, CLAUDE.md §8 limitation 3). A rate-limited call is waited out, never replaced by another provider.
 *  - The provider is PINNED (LLM_FALLBACK_PROVIDER is cleared), so every sample is from the configured one and the
 *    summary says which answered. A fallback would silently mix two models into one rate.
 *  - It reads the dev database: the cases name the tenants and the agent of the repo's own test data. Point them at
 *    yours with the flags below.
 *
 *   npm run prompt:probe -- --case=urdu,english,first,purpose --n=6
 *     urdu      an Urdu agent told only its name: must NOT invent what the business does
 *     english   the same in English
 *     first     grounded voice answers: must not open with "First,"
 *     purpose   agents that WERE told what the business does: must still describe themselves (no over-refusal)
 *     all       every case (the default)
 *   flags: --n=6  --demo-tenant=voice-demo  --ko-tenant=test-tenant  --ko-agent=<agent id>  --pause-ms=1500
 *
 * The judges are regular expressions calibrated on one model's wording: an instrument for comparing two prompts, not
 * a proof about another model. Exit code is always 0 — read the numbers.
 */
process.loadEnvFile?.(".env");
process.env.LLM_FALLBACK_PROVIDER = ""; // a fallback would silently mix models into the sample

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.length ? v.join("=") : true];
}));
const N = Number(args.n ?? 6);
const which = String(args.case ?? "all").split(",");
const DEMO_TENANT = String(args["demo-tenant"] ?? "voice-demo");
const KO_TENANT = String(args["ko-tenant"] ?? "test-tenant");
const KO_AGENT = args["ko-agent"] ? String(args["ko-agent"]) : null;
const PAUSE_MS = Number(args["pause-ms"] ?? 1500);

const { prisma } = await import("@/lib/db");
const { getAgentConfig } = await import("@/lib/tenant/config");
const { buildSystemInstruction } = await import("@/lib/agent/prompt");
const { generateReply } = await import("@/lib/agent/llm");
const { detectOpener } = await import("@/lib/phrases");
const { firstHabit, inventedDescription, refusesToDescribe } = await import("./prompt-judges.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask({ config, channel = "voice", chunks = [], message, greeting }) {
  const opener = detectOpener(message, { businessName: config.businessName });
  const systemInstruction = buildSystemInstruction({ config, channel, chunks, opener: opener ? { kind: opener.kind, language: opener.language } : null });
  const history = [
    ...(greeting ? [{ role: "model", parts: [{ text: greeting }] }] : []),
    { role: "user", parts: [{ text: message }] },
  ];
  for (let attempt = 0; attempt < 4; attempt++) {
    let by = null;
    try {
      const text = await generateReply({ systemInstruction, history, onProvider: (d) => (by = d) });
      return { text: String(text).trim(), by };
    } catch {
      await sleep(8000 * (attempt + 1)); // rate limit: wait it out rather than fall back
    }
  }
  return { text: "<<FAILED>>", by: null };
}

const results = [];
async function run(label, cfgOrFn, questions, { chunks = [], greeting, judge }) {
  const config = typeof cfgOrFn === "function" ? await cfgOrFn() : cfgOrFn;
  for (const q of questions) {
    let bad = 0;
    const samples = [];
    for (let i = 0; i < N; i++) {
      const r = await ask({ config, chunks: typeof chunks === "function" ? await chunks(q) : chunks, message: q, greeting });
      const flagged = r.text === "<<FAILED>>" ? false : judge(r.text);
      if (flagged) bad++;
      samples.push({ ...r, flagged });
      await sleep(PAUSE_MS);
    }
    const models = [...new Set(samples.map((s) => s.by))].join(" | ");
    console.log(`\n### ${label} — "${q}" — flagged ${bad}/${N} — answered by: ${models}`);
    for (const s of samples) console.log(`  ${s.flagged ? "✗" : "✓"} ${s.text.replace(/\s+/g, " ")}`);
    results.push({ label, q, bad, n: N, failed: samples.filter((s) => s.text === "<<FAILED>>").length });
  }
}

/** The stored passages for a question: the section whose heading fits (hours / delivery / karahi), else the first two. */
const koChunks = async (q) => {
  const all = await prisma.knowledgeChunk.findMany({
    where: { tenantId: KO_TENANT, sourceTitle: { startsWith: "ko-" } },
    select: { sourceTitle: true, heading: true, content: true, ordinal: true },
    orderBy: [{ sourceTitle: "asc" }, { ordinal: "asc" }],
  });
  const pick = /hours/i.test(q) ? /Opening Hours/ : /deliver/i.test(q) ? /Delivery/ : /karahi/i.test(q) ? /Karahi/ : /./;
  return all.filter((c) => pick.test(c.heading ?? "")).slice(0, 2);
};

if (which.includes("urdu") || which.includes("all")) {
  await run(
    "Urdu agent, name only",
    () => getAgentConfig(DEMO_TENANT),
    ["آپ کون ہیں اور آپ کیا کرتے ہیں؟", "آپ کی کمپنی کے بارے میں بتائیں"],
    { greeting: "السلام علیکم، Nyron Software کو کال کرنے کا شکریہ۔ آپ ایک اے آئی اسسٹنٹ سے بات کر رہے ہیں۔ میں آپ کی کیا مدد کر سکتا ہوں؟", judge: inventedDescription }
  );
}
if (which.includes("english") || which.includes("all")) {
  await run(
    "English agent, name only (Nyron Software Solutions, no purpose)",
    async () => ({ ...(await getAgentConfig(DEMO_TENANT)), replyLanguage: "en", businessName: "Nyron Software Solutions", purpose: "", profileSummary: null, voices: {} }),
    ["Who are you and what do you do?", "Tell me about your company"],
    { greeting: "Hello, thanks for calling Nyron Software Solutions. You're speaking with an AI assistant. How can I help you today?", judge: inventedDescription }
  );
}
if (which.includes("first") || which.includes("all")) {
  await run(
    "grounded voice answers (no \"First,\" opener)",
    () => getAgentConfig(KO_TENANT, KO_AGENT ? { agentId: KO_AGENT } : undefined),
    ["What are your opening hours on Friday?", "Do you deliver, and how long does it usually take?", "How much is a full chicken karahi?"],
    { chunks: koChunks, greeting: "Hello, thanks for calling. How can I help you today?", judge: firstHabit }
  );
}
if (which.includes("purpose") || which.includes("all")) {
  await run(
    "English agent WITH a purpose (must still describe itself)",
    async () => ({ ...(await getAgentConfig(DEMO_TENANT)), replyLanguage: "en", businessName: "Acme Dental", purpose: "We run a family dental clinic in Karachi offering checkups, braces and teeth whitening.", profileSummary: null, voices: {} }),
    ["Who are you and what do you do?", "Tell me about your company"],
    { greeting: "Hello, thanks for calling Acme Dental. You're speaking with an AI assistant. How can I help you today?", judge: refusesToDescribe }
  );
  await run(
    "Urdu agent WITH a purpose (must still describe itself)",
    async () => ({ ...(await getAgentConfig(DEMO_TENANT)), businessName: "Acme Dental", purpose: "ہم کراچی میں ایک فیملی ڈینٹل کلینک چلاتے ہیں جہاں معائنہ، بریسز اور دانتوں کی وائٹننگ کی جاتی ہے۔", profileSummary: null }),
    ["آپ کون ہیں اور آپ کیا کرتے ہیں؟"],
    { greeting: "السلام علیکم، Acme Dental کو کال کرنے کا شکریہ۔ میں آپ کی کیا مدد کر سکتا ہوں؟", judge: refusesToDescribe }
  );
}

console.log("\n=== SUMMARY (flagged = the bad thing happened; lower is better) ===");
for (const r of results) console.log(`${String(r.bad).padStart(2)}/${r.n} flagged${r.failed ? `  (${r.failed} call(s) FAILED and are not counted)` : ""}  ${r.label} — "${r.q}"`);
await prisma.$disconnect();
process.exit(0);
