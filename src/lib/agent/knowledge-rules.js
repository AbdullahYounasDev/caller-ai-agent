/**
 * The PURE half of knowledge-access.js (CLAUDE.md §6.28) — no database, no Prisma — so the
 * console can import the very same rule it displays ("used by this agent") instead of keeping
 * its own copy that could drift from what retrieval does.
 */

/** At most this many agents per document — the engine's own cap on active agents (§6.27). */
export const MAX_AGENTS_PER_DOCUMENT = 25;

const AGENT_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Read what a request says about a document's availability.
 *
 *   undefined          → not given: leave it as it is (a new document is shared)
 *   null | "all"       → shared with every agent
 *   ["id", …]          → only these agents (deduplicated)
 *
 * An EMPTY list is refused rather than read as "nobody" or "everybody": "nobody" would be a
 * document the business uploaded and no agent can ever use, and "everybody" is what `null`
 * says plainly — an empty list is almost always a form sent before anything was ticked.
 *
 * @param {unknown} input
 * @returns {{ok: true, agentIds: string[]|null|undefined} | {ok: false, code: "agentsInvalid"|"agentsEmpty"|"agentsTooMany"}}
 */
export function normalizeAgentList(input) {
  if (input === undefined) return { ok: true, agentIds: undefined };
  if (input === null || input === "all") return { ok: true, agentIds: null };
  if (!Array.isArray(input)) return { ok: false, code: "agentsInvalid" };
  const ids = [...new Set(input)];
  if (!ids.every((id) => typeof id === "string" && AGENT_ID.test(id))) return { ok: false, code: "agentsInvalid" };
  if (!ids.length) return { ok: false, code: "agentsEmpty" };
  if (ids.length > MAX_AGENTS_PER_DOCUMENT) return { ok: false, code: "agentsTooMany" };
  return { ok: true, agentIds: ids };
}

/**
 * The rule itself, for one document: may this agent answer from it? Mirrors agentAccessSql
 * exactly (that is what tests/knowledge-access.test.mjs pins); used wherever the answer is
 * needed outside SQL — the document list's "used by this agent" flag.
 *
 * @param {string[]} linkedAgentIds the document's rows in knowledge_source_agents
 * @param {string|null|undefined} agentId the agent asking; none = shared documents only
 */
export function canAgentUse(linkedAgentIds, agentId) {
  if (!linkedAgentIds?.length) return true;
  return Boolean(agentId) && linkedAgentIds.includes(agentId);
}
