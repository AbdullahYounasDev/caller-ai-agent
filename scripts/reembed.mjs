#!/usr/bin/env node
/**
 * RE-EMBED existing documents under the current embedding scheme.
 *
 * Anything that changes what gets embedded (a title prefix, a taskType, the
 * chunker) changes every vector it touches, and old rows keep their old ones —
 * see src/lib/agent/embed-scheme.js. This rebuilds the chunks of every document
 * embedded under an OLDER scheme, from the text already stored on the row
 * (§6.10: `content` is the original, so there is no re-upload), one document at a
 * time:
 *
 *   embed ALL of a document's chunks  →  swap them in, in ONE transaction
 *
 * so a quota stop or a crash leaves that document exactly as it was — answering
 * from its old chunks — and never with none. It records the scheme on each
 * document as it goes, so it is RESTARTABLE: run it again after a stop and it
 * only touches what is left.
 *
 * The free embedding quota is ~1000 TEXTS a day, counted per text (batching does
 * not save any, §6.20) — so every chunk is one unit of it. ALWAYS run the dry run
 * first.
 *
 * Usage:
 *   npm run reembed:dry                      # count what it would do; embeds nothing
 *   npm run reembed                          # re-embed everything stale
 *   npm run reembed -- --tenant=__eval_real__   # one tenant
 *   npm run reembed -- --max-texts=300       # stop cleanly after ~300 chunks (spend part of the day's quota)
 *   npm run reembed -- --pace-ms=1500        # pause between batches (default 700)
 *
 * Exit codes: 0 done · 1 some documents failed · 3 stopped on the DAILY quota
 * (resume after it resets) · 4 stopped on --max-texts.
 *
 * Safe while the app is running. A document edited or re-uploaded mid-run is left
 * alone (its own ingest already used the current scheme).
 */
import { prisma } from "@/lib/db";
import { chunksForDocument } from "@/lib/agent/prepare";
import { reembedSource } from "@/lib/agent/ingest";
import { isQuotaExhausted } from "@/lib/agent/retry";
import {
  EMBEDDING_SCHEME_VERSION,
  EMBED_DOCUMENT_TITLE,
  STRUCTURED_TABLES,
  USE_EMBEDDING_TASK_TYPES,
} from "@/lib/agent/embed-scheme";

process.loadEnvFile?.(".env");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DRY = process.argv.includes("--dry-run");
const TENANT = arg("tenant");
const PACE_MS = Number(arg("pace-ms") ?? 700);
const MAX_TEXTS = Number(arg("max-texts") ?? Infinity);
const DAILY_QUOTA_TEXTS = 1000;
const BATCH = 16; // mirrors EMBED_BATCH_SIZE in ingest.js — used only to report request counts

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(
    `embedding scheme v${EMBEDDING_SCHEME_VERSION}  (document title: ${EMBED_DOCUMENT_TITLE ? "on" : "off"}, ` +
      `taskType: ${USE_EMBEDDING_TASK_TYPES ? "on" : "off"}, ` +
      `structured tables: ${STRUCTURED_TABLES ? "on" : "off"})\n`
  );

  const stale = await prisma.knowledgeSource.findMany({
    where: {
      status: "ready",
      embeddingScheme: { lt: EMBEDDING_SCHEME_VERSION },
      ...(TENANT ? { tenantId: TENANT } : {}),
    },
    orderBy: [{ tenantId: "asc" }, { title: "asc" }],
    select: { id: true, tenantId: true, title: true, content: true, fileName: true },
  });

  if (!stale.length) {
    console.log("Nothing to do — every ready document is on the current scheme.");
    return 0;
  }

  // What each document will cost. Chunking is local and free; only the embed
  // step spends quota, and it spends exactly one unit per chunk.
  const plan = stale.map((s) => ({ ...s, chunks: chunksForDocument({ text: s.content, title: s.title, fileName: s.fileName }).length }));
  const byTenant = new Map();
  for (const p of plan) {
    const t = byTenant.get(p.tenantId) ?? { docs: 0, chunks: 0 };
    t.docs++;
    t.chunks += p.chunks;
    byTenant.set(p.tenantId, t);
  }
  const totalChunks = plan.reduce((n, p) => n + p.chunks, 0);
  const totalRequests = plan.reduce((n, p) => n + Math.ceil(p.chunks / BATCH), 0);

  console.log("tenant".padEnd(32), "docs".padStart(5), "chunks".padStart(7));
  for (const [tenant, t] of byTenant) console.log(tenant.padEnd(32), String(t.docs).padStart(5), String(t.chunks).padStart(7));
  console.log(
    `\n${plan.length} document(s), ${totalChunks} chunks → ${totalChunks} embedding texts ` +
      `(${totalRequests} requests of up to ${BATCH}).\n` +
      `That is ${((totalChunks / DAILY_QUOTA_TEXTS) * 100).toFixed(0)}% of a ~${DAILY_QUOTA_TEXTS}-text daily free quota, ` +
      `counted per text — batching saves time, not quota.\n`
  );

  if (DRY) {
    console.log("dry run — nothing embedded, nothing written.");
    return 0;
  }

  const totals = { reembedded: 0, skipped: 0, superseded: 0, failed: 0, texts: 0 };

  for (const p of plan) {
    if (totals.texts + p.chunks > MAX_TEXTS && totals.texts > 0) {
      console.log(`\nstopping before "${p.title}" — --max-texts=${MAX_TEXTS} reached (${totals.texts} embedded).`);
      return summarise(totals, plan.length, 4);
    }

    // A per-MINUTE 429 clears on its own; a DAILY one will not. Wait out the
    // first kind (a few times), stop cleanly on the second.
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await reembedSource({
          tenantId: p.tenantId,
          id: p.id,
          // Called before every batch (and once after the last) — pace here, which
          // also keeps this inside the free tier's per-minute cap.
          onProgress: async (_stage, done) => {
            if (done > 0) await sleep(PACE_MS);
          },
        });
        if (result.status === "reembedded") {
          totals.reembedded++;
          totals.texts += result.chunks;
          console.log(`  ✓ ${p.tenantId} / ${p.title}  (${result.chunks} chunks)`);
        } else {
          totals[result.status]++;
          console.log(`  – ${p.tenantId} / ${p.title}  ${result.status}: ${result.reason}`);
        }
        break;
      } catch (err) {
        const message = String(err?.message ?? err);
        if (isQuotaExhausted(err) && /PerDay|per day/i.test(message)) {
          console.log(`\n✗ DAILY embedding quota exhausted at "${p.title}". It was left untouched (still on its old chunks).`);
          return summarise(totals, plan.length, 3);
        }
        if (isQuotaExhausted(err) && attempt <= 4) {
          console.log(`  … rate limited, waiting 65s (attempt ${attempt}/4)`);
          await sleep(65_000);
          continue;
        }
        totals.failed++;
        console.log(`  ✗ ${p.tenantId} / ${p.title}  failed: ${message.slice(0, 160)}`);
        break;
      }
    }
  }

  return summarise(totals, plan.length, totals.failed ? 1 : 0);
}

function summarise(totals, planned, code) {
  const left = planned - totals.reembedded - totals.skipped - totals.superseded - totals.failed;
  console.log(
    `\nre-embedded ${totals.reembedded} · skipped ${totals.skipped} · superseded ${totals.superseded} · ` +
      `failed ${totals.failed} · not reached ${left}  (${totals.texts} texts embedded)`
  );
  if (code === 3 || code === 4) console.log("Run it again to resume — it only touches what is left.");
  return code;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    // exitCode, not process.exit(): on Windows with Node 24, process.exit() while
    // handles are still closing aborts with a libuv assertion and replaces the code
    // below with 127 — which would make "stopped on the daily quota" (3) unreadable.
    process.exitCode = code;
  })
  .catch(async (err) => {
    console.error("reembed failed:", err);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
