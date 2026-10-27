import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { generateReply } from "./llm";
import { buildSummaryInstruction, buildSummaryInput } from "./prompt";
import { agentsBySource, canAgentUse } from "./knowledge-access";
import { SUMMARY_MAX_DOCUMENTS, clipSummary, normalizeSummary, stripPrices } from "./summary-rules";

/**
 * THE BUSINESS SUMMARY — written by the AI from documents the owner chose, approved by the owner,
 * kept in the agent's profile (CLAUDE.md §6.20).
 *
 * The owner ticks the documents that describe the business as a whole (a company overview, an
 * "about us") in the Knowledge tab and asks for a summary. ONE model call writes a short overview
 * of the general facts in them; code removes any sentence with a price (summary-rules.js); the
 * owner reads the draft, edits it and saves it — nothing is saved by this file. Saved, it sits in
 * ABOUT THIS BUSINESS on every turn, so "who are you?" / "what do you do?" are answered at once
 * without a search, while a price or a detail is still searched for in the documents.
 *
 * Only documents the AGENT may use can be summarised for it (§6.28): a Dublin-only page must
 * never end up in London's profile. The documents a summary came from are remembered with a hash
 * of their text, so the console can say when one has changed or gone since.
 */

/** Per document and in total: enough for any overview, small enough for one cheap call. */
const DOCUMENT_CHARS = 8_000;
const TOTAL_CHARS = 40_000;
const SUMMARY_WORDS = 120;

const hashOf = (text) => createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);

/**
 * Write a DRAFT summary of the chosen documents for one agent. Saves nothing.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string|null} args.agentId       the agent it is for (null = the default agent with no row yet: shared documents only)
 * @param {string} [args.businessName]
 * @param {string[]} args.sourceIds        the documents the owner ticked
 * @param {"en"|"ur"} args.language        what the owner reads and edits it in
 * @param {(args: object) => Promise<string>} [args.generate]  llm.js generateReply — injected so tests never call a provider
 * @returns {Promise<{draft: string, sources: Array<{id: string, title: string}>, skipped: Array<{id: string, title: string|null, reason: string}>, removed: string[]}>}
 */
export async function draftSummary({ tenantId, agentId, businessName, sourceIds, language, generate = generateReply }) {
  const ids = [...new Set((sourceIds ?? []).filter((id) => typeof id === "string"))].slice(0, SUMMARY_MAX_DOCUMENTS);
  const [rows, restricted] = await Promise.all([
    prisma.knowledgeSource.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, title: true, content: true, status: true } }),
    agentsBySource(tenantId),
  ]);

  const skipped = [];
  const usable = [];
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) skipped.push({ id, title: null, reason: "not_found" });
    else if (!canAgentUse(restricted.get(id) ?? null, agentId)) skipped.push({ id, title: row.title, reason: "not_for_agent" });
    else if (row.status !== "ready" || !row.content?.trim()) skipped.push({ id, title: row.title, reason: "not_ready" });
    else usable.push(row);
  }
  if (!usable.length) return { draft: "", sources: [], skipped, removed: [] };

  let budget = TOTAL_CHARS;
  const documents = usable.map((row) => {
    const content = row.content.slice(0, Math.min(DOCUMENT_CHARS, Math.max(0, budget)));
    budget -= content.length;
    return { title: row.title, content };
  }).filter((d) => d.content);

  const raw = await generate({
    systemInstruction: buildSummaryInstruction({ language, businessName, maxWords: SUMMARY_WORDS }),
    history: [{ role: "user", parts: [{ text: buildSummaryInput(documents) }] }],
  });
  const { text, removed } = stripPrices(normalizeSummary(raw));
  return { draft: clipSummary(text), sources: usable.map((r) => ({ id: r.id, title: r.title })), skipped, removed };
}

/**
 * The documents a saved summary came from, as stored: only this tenant's, each with a hash of its
 * text NOW (built on the server — a client never says what a document contained).
 *
 * @param {string} tenantId
 * @param {string[]} ids
 * @returns {Promise<Array<{id: string, title: string, hash: string}>>}
 */
export async function resolveSummarySources(tenantId, ids) {
  const wanted = [...new Set((ids ?? []).filter((id) => typeof id === "string"))].slice(0, SUMMARY_MAX_DOCUMENTS);
  if (!wanted.length) return [];
  const rows = await prisma.knowledgeSource.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true, title: true, content: true } });
  return wanted.map((id) => rows.find((r) => r.id === id)).filter(Boolean).map((r) => ({ id: r.id, title: r.title, hash: hashOf(r.content) }));
}

/**
 * Has anything the summary was written from changed since? A document whose text is different
 * (a rename alone is not a change) or that was deleted.
 *
 * @param {string} tenantId
 * @param {Array<{id: string, title: string, hash: string}>} sources
 * @returns {Promise<{stale: boolean, changed: string[], missing: string[]}>}
 */
export async function summaryStatus(tenantId, sources) {
  const list = Array.isArray(sources) ? sources.filter((s) => s && typeof s.id === "string") : [];
  if (!list.length) return { stale: false, changed: [], missing: [] };
  const rows = await prisma.knowledgeSource.findMany({ where: { tenantId, id: { in: list.map((s) => s.id) } }, select: { id: true, title: true, content: true } });
  const changed = [];
  const missing = [];
  for (const source of list) {
    const row = rows.find((r) => r.id === source.id);
    if (!row) missing.push(source.title);
    else if (hashOf(row.content) !== source.hash) changed.push(row.title);
  }
  return { stale: changed.length + missing.length > 0, changed, missing };
}

/**
 * May a summary be copied to a new agent made from this one? Only when every document it came
 * from is shared with every agent — a summary of the Dublin-only page must not reach Galway (§6.28).
 *
 * @param {string} tenantId
 * @param {Array<{id: string}>} sources
 */
export async function summaryIsShared(tenantId, sources) {
  const ids = (Array.isArray(sources) ? sources : []).map((s) => s?.id).filter((id) => typeof id === "string");
  if (!ids.length) return true;
  return (await prisma.knowledgeSourceAgent.count({ where: { tenantId, sourceId: { in: ids } } })) === 0;
}
