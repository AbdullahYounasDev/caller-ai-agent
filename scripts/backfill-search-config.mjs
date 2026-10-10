#!/usr/bin/env node
/**
 * Label existing chunks with their document's text-search language (§6.3).
 *
 * The migration gave every existing chunk `search_config = 'english'` — exactly what
 * the keyword rank always used — so nothing changed when it was applied. This
 * detects each DOCUMENT's language from its stored `content` (src/lib/agent/language.js)
 * and re-labels its chunks; Postgres regenerates `content_tsv` for the rows that change.
 *
 * Costs NO embeddings: it never touches a vector, only the keyword index, so unlike
 * a re-embed (§6.2) it needs no quota and does not move MAX_DISTANCE.
 * Idempotent. New and re-embedded documents are labelled at write time.
 *
 * Usage: npm run db:backfill-search [-- --dry-run] [-- --tenant=ID]
 */
import { prisma } from "@/lib/db";
import { detectSearchConfig } from "@/lib/agent/language";

const DRY = process.argv.includes("--dry-run");
const tenant = process.argv.find((a) => a.startsWith("--tenant="))?.split("=")[1];

const sources = await prisma.knowledgeSource.findMany({
  where: { status: "ready", ...(tenant ? { tenantId: tenant } : {}) },
  select: { id: true, tenantId: true, title: true, content: true },
  orderBy: [{ tenantId: "asc" }, { title: "asc" }],
});

const totals = { english: 0, italian: 0, simple: 0 };
let changed = 0;
for (const s of sources) {
  const config = detectSearchConfig(s.content);
  totals[config]++;
  const n = DRY
    ? Number((await prisma.$queryRaw`SELECT count(*)::int AS n FROM ai_engine.knowledge_chunks WHERE source_id = ${s.id} AND search_config <> ${config}::regconfig`)[0].n)
    : await prisma.$executeRaw`UPDATE ai_engine.knowledge_chunks SET search_config = ${config}::regconfig WHERE source_id = ${s.id} AND search_config <> ${config}::regconfig`;
  if (n) console.log(`  ${DRY ? "would relabel" : "relabelled"} ${n} chunk(s) → ${config}: ${s.tenantId} / ${s.title}`);
  changed += n;
}
console.log(`\n${sources.length} document(s): ${totals.english} english, ${totals.italian} italian, ${totals.simple} simple — ${changed} chunk(s) ${DRY ? "would change" : "relabelled"}.`);
await prisma.$disconnect();
