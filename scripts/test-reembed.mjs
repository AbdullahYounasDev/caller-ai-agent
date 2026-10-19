/**
 * Does a re-embed keep its promises? Runs the REAL ingest.js (batching, chunk swap,
 * reembedSource) against the real database with ONLY the embedding call faked, in a
 * throwaway tenant, so it costs no quota. Guards the invariants that are easy to
 * break and invisible when broken:
 *   - a failure mid-document leaves the old chunks fully in place (§6.10)
 *   - a re-embed does NOT bump updated_at (the conflict rule's recency signal)
 *   - an edit during embedding supersedes the swap
 *   - cancel is honoured BEFORE the next batch's request is spent (§6.14)
 *   - ingest embeds with role "document", in batches of <= 16
 * Run: npm run test:reembed
 */
process.loadEnvFile(".env");
const { prisma } = await import("@/lib/db");
const stub = await import("./test-reembed-stub.mjs");
const { ingestDocument, reembedSource } = await import("@/lib/agent/ingest");
const scheme = await import("@/lib/agent/embed-scheme");
const T = "__reembed_test__";
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++; };
console.log("scheme version in this run:", scheme.EMBEDDING_SCHEME_VERSION, "(stub ingest runs at the CURRENT version)\n");

const big = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${"This is paragraph text about topic " + i + ". ".repeat(1) + "Lorem ipsum dolor sit amet consectetur. ".repeat(12)}`).join("\n\n");
await prisma.knowledgeSource.deleteMany({ where: { tenantId: T } });

// 1. ordinary ingest through ingestDocument, batched, with a progress log
const prog = [];
const r = await ingestDocument({ tenantId: T, title: "big-doc.md", text: big, kind: "text", onProgress: async (s, d, t) => prog.push(`${s}:${d}/${t}`) });
const batches = stub.state.calls.slice();
ok(r.chunkCount >= 17, `ingest produced ${r.chunkCount} chunks`);
ok(batches.every((n) => n <= 16) && batches.reduce((a, b) => a + b, 0) === r.chunkCount, `embedded in batches ${JSON.stringify(batches)} = ${r.chunkCount} texts`);
ok(stub.state.role.every((x) => x === "document"), "every ingest embed call used role=document");
ok(prog.filter((p) => p.startsWith("embedding")).length === batches.length + 1, `progress checkpoint before each batch + one after: ${prog.filter((p) => p.startsWith("embedding")).join(" ")}`);
let src = await prisma.knowledgeSource.findFirst({ where: { tenantId: T, title: "big-doc.md" } });
ok(src.embeddingScheme === scheme.EMBEDDING_SCHEME_VERSION, `ingest recorded embeddingScheme=${src.embeddingScheme}`);

// 1b. the keyword index's language is chosen per DOCUMENT at ingest (§6.3)
const labels = async (id) => (await prisma.$queryRaw`select distinct search_config::text c from ai_engine.knowledge_chunks where source_id=${id}`).map((x) => x.c);
ok(JSON.stringify(await labels(src.id)) === '["english"]', "English document → every chunk search_config = english");
const ur = await ingestDocument({ tenantId: T, title: "faq-ur.md", text: "# اکثر پوچھے جانے والے سوالات\n\nGrowth پلان کی قیمت ہر مہینے دو سو انیس یورو ہے اور اس میں کلینک کے لیے سپورٹ شامل ہے۔ مفت آزمائشی مدت تمام گاہکوں کو دستیاب نہیں ہوتی، لیکن آپ ہماری ٹیم سے ڈیمو مانگ سکتے ہیں۔ سالانہ سبسکرپشن کی رقم واپسی کی پالیسی خریداری کے تیس دن کے اندر لاگو ہوتی ہے۔", kind: "text" });
const urSrc = await prisma.knowledgeSource.findFirst({ where: { tenantId: T, title: "faq-ur.md" } });
ok(JSON.stringify(await labels(urSrc.id)) === '["simple"]', "Urdu document → search_config = simple");
const tsv = await prisma.$queryRaw`select content_tsv::text t from ai_engine.knowledge_chunks where source_id=${urSrc.id} limit 1`;
ok(/'پلان'|'کلینک'|'سبسکرپشن'/.test(tsv[0].t), "content_tsv was generated with the simple config (" + tsv[0].t.slice(0, 40) + "…)");

// 2. re-embed: force the doc to look legacy by setting scheme -1
const setScheme = (v) => prisma.$executeRaw`UPDATE ai_engine.knowledge_sources SET embedding_scheme=${v} WHERE id=${src.id}`;
const chunkIds = async () => (await prisma.$queryRaw`select id from ai_engine.knowledge_chunks where source_id=${src.id} order by ordinal`).map((x) => x.id);
await setScheme(-1);
src = await prisma.knowledgeSource.findUnique({ where: { id: src.id } });
const before = { ids: await chunkIds(), updatedAt: src.updatedAt.getTime(), content: src.content };
stub.state.calls.length = 0;
const res = await reembedSource({ tenantId: T, id: src.id });
const after = await prisma.knowledgeSource.findUnique({ where: { id: src.id } });
const afterIds = await chunkIds();
ok(res.status === "reembedded" && res.chunks === afterIds.length, `reembedSource → ${JSON.stringify(res)}`);
ok(afterIds.length === before.ids.length && afterIds.every((id) => !before.ids.includes(id)), "chunks replaced (new ids, same count)");
ok(after.updatedAt.getTime() === before.updatedAt, "updated_at UNCHANGED by re-embed (conflict-recency signal preserved)");
ok(after.embeddingScheme === scheme.EMBEDDING_SCHEME_VERSION && after.content === before.content && after.status === "ready", "scheme recorded, content/status untouched");
ok((await reembedSource({ tenantId: T, id: src.id })).status === "skipped", "second run is a no-op (resumable)");

// 3. quota stop mid-document: old chunks must survive intact
await setScheme(-1);
const ids0 = await chunkIds();
stub.state.calls.length = 0; stub.state.failOnCall = 2;
let threw = null; try { await reembedSource({ tenantId: T, id: src.id }); } catch (e) { threw = e; }
stub.state.failOnCall = null;
const ids1 = await chunkIds();
ok(threw?.status === 429, "quota error on the 2nd batch propagated");
ok(ids1.length === ids0.length && ids1.every((id, i) => id === ids0[i]), "document still has ALL its old chunks after a mid-document failure");
ok((await prisma.knowledgeSource.findUnique({ where: { id: src.id } })).embeddingScheme === -1, "scheme not advanced after failure (will be retried)");

// 4. edited while embedding -> superseded, old chunks kept
stub.state.calls.length = 0;
stub.state.onCall = async (n) => { if (n === 2) await prisma.knowledgeSource.update({ where: { id: src.id }, data: { error: null } }); }; // @updatedAt bumps
const sup = await reembedSource({ tenantId: T, id: src.id });
stub.state.onCall = null;
ok(sup.status === "superseded", `edit during embed → ${sup.status}`);
const ids2 = await chunkIds();
ok(ids2.length === ids0.length && ids2.every((id, i) => id === ids0[i]), "superseded swap left old chunks in place");

// 5. cooperative cancel: progress hook throws -> no further batch requests are spent
await setScheme(-1);
src = await prisma.knowledgeSource.findUnique({ where: { id: src.id } });
stub.state.calls.length = 0;
let n = 0; let cancelled = null;
try { await reembedSource({ tenantId: T, id: src.id, onProgress: async () => { if (++n === 2) throw new Error("CANCEL"); } }); } catch (e) { cancelled = e; }
ok(cancelled?.message === "CANCEL" && stub.state.calls.length === 1, `cancel at checkpoint 2 stopped after ${stub.state.calls.length} batch request (checked BEFORE the next is spent)`);
const ids3 = await chunkIds();
ok(ids3.length === ids0.length && ids3.every((id, i) => id === ids0[i]), "cancelled re-embed left old chunks in place");

// ───────────────────────── INCREMENTAL RE-EMBED (§6.21) ─────────────────────────
// A replace / edit / retry embeds only the chunks whose exact embedText changed.
const { chunkDocument } = await import("@/lib/agent/chunk");
const { retrySource } = await import("@/lib/agent/ingest");
const para = (i, price = 100 + i) => `Item ${i} is described here at length. The price of item ${i} is ${price} euros. ` + "It comes with a full warranty and free support. ".repeat(8);
const sections = (n, over = {}) => Array.from({ length: n }, (_, i) => `## Section ${i}\n\n${over[i] ?? para(i)}`);
const doc40 = sections(40).join("\n\n");
const INC = "inc.md";
const spent = () => stub.state.texts.length;
const reset = () => { stub.state.calls.length = 0; stub.state.texts.length = 0; stub.state.role.length = 0; };
const ingest = (text, extra = {}) => ingestDocument({ tenantId: T, title: INC, text, kind: "text", ...extra });
const incSrc = () => prisma.knowledgeSource.findFirst({ where: { tenantId: T, title: INC } });
const rowsOf = async () => prisma.$queryRaw`select c.ordinal, c.content, c.embedding::text v, c.embed_hash h, c.id from ai_engine.knowledge_chunks c join ai_engine.knowledge_sources s on s.id=c.source_id where s.tenant_id=${T} and s.title=${INC} order by c.ordinal`;
const parse = (t) => t.slice(1, -1).split(",").map(Number);
const close = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-5);
// ORACLE: every stored vector must be the vector of the text its chunk would be embedded as TODAY.
// If reuse ever attached a vector to the wrong text, this is where it shows.
const verify = async (text, label) => {
  const want = chunkDocument(text);
  const got = await rowsOf();
  const okAll = want.length === got.length && want.every((c, i) => got[i].content === c.content && close(parse(got[i].v), stub.vec(c.embedText)));
  ok(okAll, `${label}: all ${got.length} stored vectors equal the vector of their own text`);
};

await prisma.knowledgeSource.deleteMany({ where: { tenantId: T, title: INC } });
reset();
const first = await ingest(doc40);
const N = first.chunkCount;
ok(N === 40 && spent() === 40 && first.reusedChunks === 0, `inc: new 40-chunk document embeds ${spent()} texts, reuses ${first.reusedChunks}`);
let stored = await rowsOf();
ok(stored.every((r) => /^[0-9a-f]{64}$/.test(r.h)), "every chunk stored its embed_hash");
await verify(doc40, "inc/new");

// unchanged re-upload
reset();
const before1 = await rowsOf();
const again = await ingest(doc40);
const after1 = await rowsOf();
ok(spent() === 0 && stub.state.calls.length === 0, `unchanged re-upload = ${spent()} embed calls (was 40 texts)`);
ok(again.reusedChunks === 40 && again.embeddedTexts === 0 && again.chunkCount === 40, `result reports reusedChunks=${again.reusedChunks} embeddedTexts=${again.embeddedTexts}`);
ok(after1.every((r, i) => r.v === before1[i].v && r.h === before1[i].h && r.content === before1[i].content), "the vector read back is byte-identical to the one stored");
ok(after1.every((r, i) => r.id !== before1[i].id), "…and the chunks were still swapped in as new rows (one transaction)");

// one changed price
reset();
const edited = sections(40, { 17: para(17, 999) }).join("\n\n");
const e1 = await ingest(edited);
ok(spent() === 1 && stub.state.texts[0].includes("999 euros"), `ONE changed price in a 40-chunk doc = ${spent()} text embedded (before this change: 40)`);
ok(e1.reusedChunks === 39 && e1.embeddedTexts === 1, `39 of 40 chunks reused`);
const after2 = await rowsOf();
ok(after2.every((r, i) => i === 17 ? r.v !== before1[i].v : r.v === before1[i].v), "only chunk 17's vector changed; the other 39 are untouched");
await verify(edited, "inc/one-edit");

// retry of a failed document keeps its chunks and costs nothing
reset();
await prisma.$executeRaw`UPDATE ai_engine.knowledge_sources SET status='failed', error='quota' WHERE id=${(await incSrc()).id}`;
const retried = await retrySource({ tenantId: T, id: (await incSrc()).id });
ok(spent() === 0 && retried.reusedChunks === 40, `retry of an already-embedded document = ${spent()} texts`);
ok((await incSrc()).status === "ready", "retry left the document ready");

// scheme mismatch → full re-embed, nothing reused
reset();
await prisma.$executeRaw`UPDATE ai_engine.knowledge_sources SET embedding_scheme=-1 WHERE id=${(await incSrc()).id}`;
const mism = await ingest(edited);
ok(spent() === 40 && mism.reusedChunks === 0, `scheme-version mismatch = FULL re-embed (${spent()} texts, 0 reused) — a vector from another scheme is never reused`);
ok((await incSrc()).embeddingScheme === scheme.EMBEDDING_SCHEME_VERSION, "…and the document is back on the current scheme");
// a stored hash with NO scheme match must not be trusted even if the text is identical (covered above); NULL hash too:
reset();
await prisma.$executeRaw`UPDATE ai_engine.knowledge_chunks SET embed_hash=NULL WHERE source_id=${(await incSrc()).id}`;
const nullh = await ingest(edited);
ok(spent() === 40 && nullh.reusedChunks === 0, "rows written before embed_hash existed (NULL) are never reused → full embed once");
reset();
ok((await ingest(edited)).reusedChunks === 40 && spent() === 0, "…after which the document is incremental again");

// failure mid-way: 20 changed chunks = 2 batches, the 2nd fails
{
  const many = sections(40, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, para(i, 5000 + i)]))).join("\n\n");
  const oldRows = await rowsOf();
  const oldSrc = await incSrc();
  reset(); stub.state.failOnCall = 2;
  let err = null; try { await ingest(many); } catch (e) { err = e; }
  stub.state.failOnCall = null;
  const nowRows = await rowsOf();
  ok(err?.status === 429, "inc: quota error on batch 2 propagated");
  ok(nowRows.length === 40 && nowRows.every((r, i) => r.id === oldRows[i].id && r.v === oldRows[i].v), "failure mid-way leaves ALL old chunks (same ids, same vectors) in place");
  const nowSrc = await incSrc();
  ok(nowSrc.content === oldSrc.content && nowSrc.status === "ready", "…and the row is rolled back to the old content (§6.10)");
  await verify(edited, "inc/after-failure");

  // cancellation checkpoint is still BEFORE each batch: cancel at the 2nd embedding checkpoint
  reset(); let k = 0; let cancel = null;
  try { await ingest(many, { onProgress: async (stage) => { if (stage === "embedding" && ++k === 2) throw new Error("CANCEL"); } }); } catch (e) { cancel = e; }
  ok(cancel?.message === "CANCEL" && stub.state.calls.length === 1, `cancel before batch 2 spent only ${stub.state.calls.length} batch request (20 changed texts → 2 batches, reused chunks cost no batch)`);
  ok((await rowsOf()).every((r, i) => r.id === oldRows[i].id), "…and left the old chunks in place");

  // and the same edit, uninterrupted, costs exactly the 20 changed texts
  reset();
  const ok20 = await ingest(many);
  ok(spent() === 20 && ok20.reusedChunks === 20, `20 changed of 40 = ${spent()} texts in ${stub.state.calls.length} batches`);
  await verify(many, "inc/20-edit");
}

// duplicate identical chunks in one document
{
  const dupPara = para(7);
  const dups = [`## Boiler\n\n${dupPara}`, `## Boiler\n\n${dupPara}`, `## Boiler\n\n${dupPara}`, `## Other\n\n${para(8)}`].join("\n\n");
  reset();
  const d = await ingest(dups);
  ok(d.chunkCount === 4 && spent() === 2, `3 identical chunks + 1 other: ${d.chunkCount} chunks cost ${spent()} texts (identical text embeds once)`);
  await verify(dups, "inc/dups-new");
  reset();
  const d2 = await ingest(dups);
  ok(spent() === 0 && d2.reusedChunks === 4, "unchanged document with duplicate chunks = 0 embeds");
  reset();
  const dupsEdited = [`## Boiler\n\n${dupPara}`, `## Boiler\n\n${para(7, 777)}`, `## Boiler\n\n${dupPara}`, `## Other\n\n${para(8)}`].join("\n\n");
  const d3 = await ingest(dupsEdited);
  ok(spent() === 1 && d3.chunkCount === 4, `editing ONE of the duplicates = ${spent()} text`);
  await verify(dupsEdited, "inc/dups-edit");
}

// chunk order changes
{
  const base = sections(10);
  await ingest(base.join("\n\n"));
  const withVec = new Map((await rowsOf()).map((r) => [r.content, r.v]));
  reset();
  const swapped = [...base]; [swapped[2], swapped[7]] = [swapped[7], swapped[2]];
  const sw = await ingest(swapped.join("\n\n"));
  ok(spent() === 0 && sw.reusedChunks === 10, `reordered sections = ${spent()} embeds`);
  const nowRows = await rowsOf();
  ok(nowRows.every((r) => r.v === withVec.get(r.content)), "each vector followed ITS content to the new position");
  ok(nowRows[2].content.includes("Item 7") && nowRows[7].content.includes("Item 2"), "ordinals reflect the new order");
  await verify(swapped.join("\n\n"), "inc/reorder");
}

// a section merged / split by the edit
{
  const base = sections(10);
  await ingest(base.join("\n\n"));
  reset();
  const merged = [...base.slice(0, 4), base[4] + "\n\n" + base[5].replace(/^## Section 5\n\n/, ""), ...base.slice(6)].join("\n\n");
  const m = await ingest(merged);
  ok(m.chunkCount === 9 && spent() <= 2, `two sections merged by deleting a heading: ${m.chunkCount} chunks, ${spent()} embedded, ${m.reusedChunks} reused`);
  await verify(merged, "inc/merge");
  reset();
  const split = [...base.slice(0, 4), ...[base[4].split("\n\n")[1].replace(/(?<=euros\. )/, "\n\n## Extra Heading\n\n")].map((b) => "## Section 4\n\n" + b), ...base.slice(5)].join("\n\n");
  const sp = await ingest(split);
  ok(spent() <= 3 && sp.reusedChunks >= sp.chunkCount - 3, `a section split by a new heading: ${sp.chunkCount} chunks, ${spent()} embedded, ${sp.reusedChunks} reused`);
  await verify(split, "inc/split");
}

// HONEST CAVEAT, measured: a heading-less document is split greedily by size, so a change near the top can
// re-flow every chunk after it. Reported, not hidden.
{
  const flat = Array.from({ length: 80 }, (_, i) => para(i)).join("\n\n");
  await prisma.knowledgeSource.deleteMany({ where: { tenantId: T, title: INC } });
  reset(); const f0 = await ingest(flat); const nFlat = spent();
  reset();
  const flatEdited = Array.from({ length: 80 }, (_, i) => (i === 3 ? para(3, 4242) : para(i))).join("\n\n");
  const f1 = await ingest(flatEdited);
  console.log(`INFO  heading-less ${f0.chunkCount}-chunk document: first ingest ${nFlat} texts; one changed price near the top → ${spent()} texts (${f1.reusedChunks} reused)`);
  const flatLate = Array.from({ length: 80 }, (_, i) => (i === 75 ? para(75, 4343) : (i === 3 ? para(3, 4242) : para(i)))).join("\n\n");
  reset();
  const f2 = await ingest(flatLate);
  console.log(`INFO  same document, one changed price near the END → ${spent()} texts (${f2.reusedChunks} reused)`);
  await verify(flatLate, "inc/heading-less");
  // …and an edit that GROWS a paragraph by ~400 chars moves every greedy chunk boundary after it.
  reset();
  const flatGrown = Array.from({ length: 80 }, (_, i) => (i === 3 ? para(3) + "\n\n" + "A newly added paragraph about our extended opening hours. ".repeat(8) : para(i))).join("\n\n");
  const f3 = await ingest(flatGrown);
  console.log(`INFO  same document, a 400-char paragraph INSERTED near the top → ${spent()} of ${f3.chunkCount} texts (${f3.reusedChunks} reused) — boundaries after the edit re-flow`);
  ok(spent() > 10, "documented caveat holds: size-based boundaries re-flow after an insertion in a heading-less document");
  await verify(flatGrown, "inc/heading-less-insert");
}
await prisma.knowledgeSource.deleteMany({ where: { tenantId: T, title: INC } });

// ───────────────────── KEYWORD QUERY MODE (§6.22) — no embedding quota ─────────────────────
// retrieve.js's embedText is the STUB here; maxDistance 2 admits every chunk, so what is compared is
// purely the SQL and the ranking. "and" must be EXACTLY the pre-change SQL; "or" must run and stay a
// subset of what vector search admitted.
{
  const { retrieveRelevantChunks, rankCandidates, USE_OR_KEYWORD_QUERY } = await import("@/lib/agent/retrieve");
  ok(USE_OR_KEYWORD_QUERY === false, "USE_OR_KEYWORD_QUERY ships OFF");
  await ingest(sections(12).join("\n\n"));
  // the ORIGINAL STAGE-1 SQL, verbatim from before the change, as the oracle
  const legacy = async (query, topK) => {
    const lit = `[${stub.vec(query).join(",")}]`;
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`;
      return tx.$queryRaw`
        SELECT c.id, c.source_title AS "sourceTitle", c.heading, c.content, s.updated_at AS "sourceUpdatedAt",
               c.embedding <=> ${lit}::vector AS distance,
               ts_rank_cd(c.content_tsv, CASE c.search_config
                   WHEN 'simple'::regconfig  THEN plainto_tsquery('simple', ${query})
                   ELSE plainto_tsquery('english', ${query}) END) AS "keywordRank"
        FROM ai_engine.knowledge_chunks c JOIN ai_engine.knowledge_sources s ON s.id = c.source_id
        WHERE c.tenant_id = ${T} AND c.embedding <=> ${lit}::vector <= ${2}
        ORDER BY distance ASC LIMIT ${20}`;
    });
    return rankCandidates(rows, topK);
  };
  const qs = ["How much does item 7 cost with a full warranty please?", "price of item 3", "Quanto costa l'articolo 5 con garanzia?", "who are you", "item 11 free support"];
  let same = true;
  for (const q of qs) {
    const want = (await legacy(q, 5)).map((r) => r.id);
    const got = (await retrieveRelevantChunks({ tenantId: T, query: q, topK: 5, maxDistance: 2, keywordQuery: "and" })).map((r) => r.id);
    const dflt = (await retrieveRelevantChunks({ tenantId: T, query: q, topK: 5, maxDistance: 2 })).map((r) => r.id);
    if (JSON.stringify(want) !== JSON.stringify(got) || JSON.stringify(want) !== JSON.stringify(dflt)) same = false;
  }
  ok(same, `keyword mode "and" (and the default) returns exactly what the original SQL did, on ${qs.length} queries`);
  let orOk = true; let orSubset = true;
  for (const q of [...qs, "", "!!! ??? ...", "x | y & !z", "a:* <-> b (c)"]) {
    try {
      const andIds = new Set((await retrieveRelevantChunks({ tenantId: T, query: q || " ", topK: 12, maxDistance: 2, keywordQuery: "and" })).map((r) => r.id));
      const orIds = (await retrieveRelevantChunks({ tenantId: T, query: q || " ", topK: 12, maxDistance: 2, keywordQuery: "or" })).map((r) => r.id);
      if (!orIds.every((id) => andIds.has(id)) || orIds.length !== andIds.size) orSubset = false; // keyword NEVER changes membership (§6.3)
    } catch (e) { orOk = false; console.log("  or-mode error:", e.message); }
  }
  ok(orOk, 'keyword mode "or" runs on questions, filler-only, punctuation-only and tsquery-operator input without a SQL error');
  ok(orSubset, 'keyword mode "or" admits exactly the same chunks as "and" — membership is still the distance gate alone (§6.3)');
  await prisma.knowledgeSource.deleteMany({ where: { tenantId: T, title: INC } });
}

await prisma.knowledgeSource.deleteMany({ where: { tenantId: T } });
console.log(fails ?`\n${fails} FAILED` : "\nall passed"); await prisma.$disconnect();
process.exitCode = fails ? 1 : 0;
