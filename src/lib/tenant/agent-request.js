import { getAgentConfig } from "@/lib/tenant/config";

/**
 * WHICH AGENT A REQUEST IS FOR — the route-facing half of the agents seam (CLAUDE.md §6.27).
 *
 * Every route that reads or serves one agent takes an optional `agentId` query parameter and
 * goes through here, so no route grows its own idea of what an agent id may look like, what
 * "no agent named" means (the tenant's DEFAULT agent), or whether an archived agent may still
 * answer callers (it may not). The settings themselves come from tenant/config.js.
 */

/** Agent ids are agent_configs uuids. Checked before a query so junk is a 400, not a lookup. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** @param {unknown} agentId */
export function isValidAgentId(agentId) {
  return typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId);
}

/**
 * The `agentId` query parameter: absent or empty = the tenant's default agent.
 *
 * @param {URLSearchParams} params
 * @returns {{ok: true, agentId: string|null} | {ok: false}}
 */
export function readAgentId(params) {
  const raw = params.get("agentId");
  if (raw === null || raw === "") return { ok: true, agentId: null };
  return isValidAgentId(raw) ? { ok: true, agentId: raw } : { ok: false };
}

/**
 * Resolve the agent a request names (or the default) and load its settings.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {URLSearchParams} args.params
 * @param {(key: string, opts?: object) => string} args.tr bound translator
 * @param {boolean} [args.serving]   true on routes that ANSWER callers (chat, starting a call):
 *                                   an archived agent is refused there, though its settings
 *                                   and history stay readable everywhere else
 * @param {boolean} [args.skipCache]
 * @returns {Promise<{ok: true, agentId: string|null, config: object} | {ok: false, status: number, error: string}>}
 *          agentId is the RESOLVED id (the default agent's id when none was named; null only
 *          for a tenant that has no agent row yet)
 */
export async function requireAgent({ tenantId, params, tr, serving = false, skipCache = false }) {
  const named = readAgentId(params);
  if (!named.ok) return { ok: false, status: 400, error: tr("validation:agents.invalidId") };
  try {
    const config = await getAgentConfig(tenantId, { agentId: named.agentId, skipCache });
    if (serving && config.status === "archived") {
      return { ok: false, status: 409, error: tr("validation:agents.archived") };
    }
    return { ok: true, agentId: config.agentId ?? null, config };
  } catch (err) {
    const described = describeAgentError(err, tr);
    if (described) return { ok: false, ...described };
    throw err;
  }
}

/**
 * Turn an agent error from tenant/config.js into a translated route response, or null when the
 * error is something else (and should stay a 500).
 *
 * @param {unknown} err
 * @param {(key: string, opts?: object) => string} tr
 * @returns {{status: number, error: string} | null}
 */
export function describeAgentError(err, tr) {
  if (err?.code === "AGENT_NOT_FOUND") return { status: 404, error: tr("validation:agents.notFound") };
  if (err?.name === "AgentRuleError") {
    return { status: err.status ?? 400, error: tr(`validation:agents.${err.code}`, err.vars ? { vars: err.vars } : undefined) };
  }
  return null;
}

/**
 * The `where` part that limits a list (calls, requests) to one agent. Rows with NO agent were
 * served by the default agent before it had a row of its own, so they belong to the default
 * agent's list: pass `includeUnassigned` when agentId is the default agent.
 *
 * @param {string|null|undefined} agentId omitted = every agent's rows
 * @param {boolean} [includeUnassigned]
 */
export function agentScope(agentId, includeUnassigned = false) {
  if (!agentId) return {};
  return includeUnassigned ? { OR: [{ agentId }, { agentId: null }] } : { agentId };
}
