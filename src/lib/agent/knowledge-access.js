import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * WHICH AGENT MAY ANSWER FROM WHICH DOCUMENT (CLAUDE.md §6.28).
 *
 * A tenant has one knowledge LIBRARY and one or more agents (§6.27). Each document is either
 *   SHARED      — no rows in knowledge_source_agents: every agent of the tenant uses it
 *                 (a restaurant chain's menu), or
 *   RESTRICTED  — one or more rows: ONLY those agents use it (the Dublin branch's page).
 * Shared is the default and what every document was before agents existed, so a tenant that
 * never restricts anything behaves exactly as before.
 *
 * Why the rule lives on the DOCUMENT and not as "agent X uses documents [...]": a new agent
 * (a new branch) must automatically know everything shared — the menu, the policies — and must
 * NOT inherit another branch's page. Per-document availability gives exactly that with no step
 * for the owner; a per-agent list would make every new agent either see everything (including
 * the other branches) or nothing until someone ticks forty boxes.
 *
 * RETRIEVAL FAILS CLOSED. `agentAccessSql(agentId)` with no agent (null/undefined) returns
 * SHARED documents only — the most a caller that forgot to say which agent it is can get, and
 * never another agent's restricted page. Only the debug/eval paths ask for the whole library,
 * and they must say so (`wholeLibrary: true`).
 */

import { normalizeAgentList } from "./knowledge-rules";

export { MAX_AGENTS_PER_DOCUMENT, normalizeAgentList, canAgentUse } from "./knowledge-rules";

/**
 * The retrieval filter, as a SQL fragment that starts with AND. `c` must be the alias of
 * ai_engine.knowledge_chunks in the query it is put into.
 *
 * It only FILTERS: membership is still decided by MAX_DISTANCE (§6.3) among what this agent may
 * use. With the HNSW iterative scan (§6.1) a stricter filter costs more of the scan budget, not
 * correctness. Both EXISTS look up the (source_id, agent_id) primary key.
 *
 * @param {string|null|undefined} agentId
 * @param {{wholeLibrary?: boolean}} [options] debug/eval only: no filter at all
 * @returns {Prisma.Sql}
 */
export function agentAccessSql(agentId, { wholeLibrary = false } = {}) {
  if (wholeLibrary) return Prisma.empty;
  const shared = Prisma.sql`NOT EXISTS (SELECT 1 FROM ai_engine.knowledge_source_agents ksa WHERE ksa.source_id = c.source_id)`;
  if (!agentId) return Prisma.sql`AND ${shared}`;
  return Prisma.sql`AND (${shared} OR EXISTS (SELECT 1 FROM ai_engine.knowledge_source_agents ksa WHERE ksa.source_id = c.source_id AND ksa.agent_id = ${agentId}))`;
}

/**
 * Check that every id is an agent of THIS tenant — a link to another tenant's agent would be a
 * cross-tenant reference, and a link to a made-up id a document nobody can use. Archived agents
 * are accepted (a document can stay linked to a branch that is closed for now); the console only
 * offers active ones.
 *
 * @param {string} tenantId
 * @param {string[]|null|undefined} agentIds
 * @returns {Promise<{ok: true} | {ok: false, code: "agentsUnknown"}>}
 */
export async function validateAgentsForTenant(tenantId, agentIds, db = prisma) {
  if (!agentIds?.length) return { ok: true };
  const found = await db.agentConfig.count({ where: { tenantId, id: { in: agentIds } } });
  return found === agentIds.length ? { ok: true } : { ok: false, code: "agentsUnknown" };
}

/**
 * Replace a document's availability. Pass a transaction client to make it part of a larger
 * write (ingest swaps it together with the new chunks). `null` = shared.
 *
 * @param {object} db Prisma client or transaction
 * @param {{tenantId: string, sourceId: string, agentIds: string[]|null}} args
 */
export async function setSourceAgents(db, { tenantId, sourceId, agentIds }) {
  await db.knowledgeSourceAgent.deleteMany({ where: { sourceId, tenantId } });
  if (agentIds?.length) {
    await db.knowledgeSourceAgent.createMany({ data: agentIds.map((agentId) => ({ sourceId, agentId, tenantId })) });
  }
}

/**
 * Every restricted document of a tenant → the agents it is restricted to. Shared documents are
 * absent from the map.
 *
 * @param {string} tenantId
 * @returns {Promise<Map<string, string[]>>}
 */
export async function agentsBySource(tenantId, db = prisma) {
  const rows = await db.knowledgeSourceAgent.findMany({
    where: { tenantId },
    select: { sourceId: true, agentId: true },
    orderBy: { createdAt: "asc" },
  });
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.sourceId)) map.set(row.sourceId, []);
    map.get(row.sourceId).push(row.agentId);
  }
  return map;
}

/**
 * What a route does with an `agents` value from a request: read it, then check every id is an
 * agent of this tenant. `code` names a validation:knowledge.* message.
 *
 * @param {string} tenantId
 * @param {unknown} raw
 * @returns {Promise<{ok: true, agents: string[]|null|undefined} | {ok: false, code: string}>}
 */
export async function readAgentsInput(tenantId, raw) {
  const read = normalizeAgentList(raw);
  if (!read.ok) return read;
  const known = await validateAgentsForTenant(tenantId, read.agentIds);
  return known.ok ? { ok: true, agents: read.agentIds } : known;
}
