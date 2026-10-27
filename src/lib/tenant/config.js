import { prisma } from "@/lib/db";
import {
  SUPPORTED_LOCALES,
  RTL_LOCALES,
  DEFAULT_REPLY_LANGUAGE,
  isReplyLanguage,
} from "@/lib/i18n";
import { emptyCollectConfig, normalizeCollectConfig } from "@/lib/collect/config";
import { emptyHandoffConfig, normalizeHandoffConfig } from "@/lib/handoff/config";
import { normalizeGreeting } from "@/lib/voice/greeting";
import { normalizeCallEnding } from "@/lib/voice/closing";
import { assertCanAddAgent } from "@/lib/tenant/registry";
import { countNumbersForAgent } from "@/lib/standins/numbers";

/**
 * THE TENANT CONFIG SEAM — and since a tenant can have several agents, THE AGENT SEAM.
 *
 * Every part of the AI engine that needs to know anything about a business —
 * its name, persona, language and what the agent is allowed to do — goes
 * through getAgentConfig(). One function, one shape, one cache.
 *
 * AGENTS (CLAUDE.md §6.27). The engine is one brain; an AGENT is one setup it answers
 * with — one agent_configs row. A tenant has a DEFAULT agent (`default_for = tenant_id`),
 * which answers everything that names no agent: so every caller written before agents
 * existed, and every tenant that only ever has one, behaves exactly as before. A tenant
 * that has never saved anything has no row at all and gets DEFAULTS (agentId null).
 *
 * Every lookup is scoped by tenantId AND agentId together: an agent id from another
 * business is "not found", never served.
 *
 * Why a seam at all: the partner owns tenants/users/auth/plans/billing in the
 * `tenant_core` schema. If any of that ever has to be read here, it gets fetched
 * INSIDE this file and merged into the object below — so the rest of the codebase
 * never learns where a given field came from, and swapping the source is a
 * one-file change instead of a grep-and-pray.
 */

/** What a business is called until it names itself. prompt.js compares against
 *  this so a placeholder is never presented to the model as a real name. */
export const PLACEHOLDER_BUSINESS_NAME = "this business";

// Shape returned when a tenant has no agent_configs row yet. An un-onboarded
// tenant must still get a working (if generic) agent rather than a 500 — a
// number can be pointed at us before anyone finishes the setup wizard.
const DEFAULTS = {
  businessName: PLACEHOLDER_BUSINESS_NAME,
  purpose: "",
  tone: "professional",
  timezone: "UTC",
  uiLocale: "en",
  replyLanguage: DEFAULT_REPLY_LANGUAGE,
  hours: null,
  // Who a caller may be passed to, and when (lib/handoff/config.js). Off until the owner sets it up.
  escalation: emptyHandoffConfig(),
  capabilities: {},
  // { [spokenLanguage]: voiceId } — empty means every language uses its default voice
  // (lib/voice/speech/voices.js voiceFor()).
  voices: {},
  // The call's opening line (lib/voice/greeting.js): the owner's words per language, empty = the
  // built-in greeting (AI notice; recording notice only while recordCalls is on).
  greeting: {},
  recordCalls: false,
  // The call ends by itself once the conversation is over, after this many seconds of quiet
  // (lib/voice/closing.js).
  ...normalizeCallEnding(),
  // What the agent collects for a customer's request (lib/collect/config.js). Off until the
  // business sets it up, so an existing tenant's agent behaves exactly as before.
  collect: emptyCollectConfig(),
  collectVersion: 0,
};


// Re-exported from lib/i18n so there is ONE list of supported locales in the
// system, not a copy here that drifts out of step with the catalogs.
export { SUPPORTED_LOCALES, RTL_LOCALES };

const isSupported = (l) => SUPPORTED_LOCALES.includes(l);

// In-process cache. The config is read on EVERY message on every channel, and it
// changes only when a business edits it in the dashboard — so hitting Postgres
// each time is pure waste.
//
// CAVEAT, and it's a real one: this is per Node process. Run more than one
// instance and a save takes up to TTL to show up on the instances that didn't
// handle the write. That's fine at this stage (60s, and config edits are rare);
// when you scale out, move this to Redis or have /api/agent-config publish an
// invalidation. Don't silently raise the TTL to "fix" a staleness complaint.
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // `${tenantId}\u0000${agentId ?? ""}` -> { value, expiresAt }
const cacheKey = (tenantId, agentId) => `${tenantId}\u0000${agentId ?? ""}`;

/** Agents per tenant (active ones). A safety cap on the engine's side — a business plan's own
 *  limit is the backend's (registry.js canAddAgent). */
export const MAX_AGENTS_PER_TENANT = 25;
export const MAX_AGENT_NAME = 60;
export const AGENT_STATUSES = ["active", "archived"];

/** Thrown when an agent id does not exist FOR THIS TENANT. Routes turn it into a 404. */
export class AgentNotFoundError extends Error {
  constructor(agentId) {
    super(`Unknown agent: ${agentId}`);
    this.name = "AgentNotFoundError";
    this.code = "AGENT_NOT_FOUND";
    this.status = 404;
  }
}

/** Thrown when an agent change is refused for a reason the owner can act on; `code` names a
 *  validation:agents.* message. Routes turn it into a 400/409. */
export class AgentRuleError extends Error {
  constructor(code, status = 400, vars) {
    super(`Agent change refused: ${code}`);
    this.name = "AgentRuleError";
    this.code = code;
    this.status = status;
    this.vars = vars;
  }
}

/**
 * Load an agent's configuration, merged over defaults and cached.
 *
 * @param {string} tenantId
 * @param {{ agentId?: string|null, skipCache?: boolean }} [options]
 *        agentId omitted / null → the tenant's DEFAULT agent
 * @returns {Promise<object>} never null — falls back to DEFAULTS for a tenant with no agent yet
 * @throws {AgentNotFoundError} agentId given but not an agent of this tenant
 */
export async function getAgentConfig(tenantId, { agentId = null, skipCache = false } = {}) {
  if (!tenantId) throw new Error("getAgentConfig requires a tenantId");

  const key = cacheKey(tenantId, agentId);
  if (!skipCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  let value;
  if (agentId) {
    // The dashboard language is the TENANT's, kept on the default agent: read it alongside.
    const [row, fallback] = await Promise.all([
      prisma.agentConfig.findFirst({ where: { id: agentId, tenantId } }),
      prisma.agentConfig.findUnique({ where: { defaultFor: tenantId }, select: { uiLocale: true } }),
    ]);
    if (!row) throw new AgentNotFoundError(agentId);
    value = normalizeConfig(row, fallback?.uiLocale);
  } else {
    value = normalizeConfig(await prisma.agentConfig.findUnique({ where: { defaultFor: tenantId } }));
  }

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Drop a tenant's cached configs — every agent of it, since a change to one can change what
 * another reads (the default moved, the dashboard language changed). Call this from anywhere
 * that WRITES config, so a business sees its own edit take effect immediately instead of
 * waiting out the TTL — that delay reads as "the dashboard is broken".
 * @param {string} [tenantId] omit to clear every tenant
 */
export function invalidateAgentConfig(tenantId) {
  if (!tenantId) return cache.clear();
  const prefix = `${tenantId}\u0000`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

/**
 * Merge a DB row (or null) over the defaults and sanity-check the values that
 * would otherwise reach the model unchecked.
 * @param {object|null} row
 * @param {string} [tenantUiLocale] the default agent's uiLocale, for a non-default row
 */
function normalizeConfig(row, tenantUiLocale) {
  if (!row) {
    return { ...DEFAULTS, collect: emptyCollectConfig(), escalation: emptyHandoffConfig(), exists: false, agentId: null, name: "", status: "active", isDefault: true };
  }
  const uiLocale = row.defaultFor ? row.uiLocale : tenantUiLocale ?? row.uiLocale;

  return {
    exists: true,
    tenantId: row.tenantId,
    agentId: row.id,
    name: row.name ?? "",
    status: AGENT_STATUSES.includes(row.status) ? row.status : "active",
    isDefault: Boolean(row.defaultFor),
    businessName: row.businessName?.trim() || DEFAULTS.businessName,
    purpose: row.purpose ?? DEFAULTS.purpose,
    tone: row.tone ?? DEFAULTS.tone,
    timezone: row.timezone ?? DEFAULTS.timezone,
    // INTERFACE language: every screen the business owner reads. One per TENANT — it lives on
    // the default agent and every other agent reports that one.
    uiLocale: isSupported(uiLocale) ? uiLocale : DEFAULTS.uiLocale,
    // What the AGENT replies in: "en" or "ur" (it always UNDERSTANDS both). A value
    // left over from the days of "auto"/Italian degrades to the default instead of
    // reaching the prompt.
    replyLanguage: isReplyLanguage(row.replyLanguage)
      ? row.replyLanguage
      : DEFAULT_REPLY_LANGUAGE,
    hours: row.hours ?? null,
    escalation: normalizeHandoffConfig(row.escalation),
    capabilities: row.capabilities ?? {},
    voices: row.voices && typeof row.voices === "object" && !Array.isArray(row.voices) ? row.voices : {},
    greeting: normalizeGreeting(row.greeting),
    recordCalls: row.recordCalls === true,
    ...normalizeCallEnding(row),
    // Normalized on every read: a stored document that has drifted from the schema degrades
    // to the nearest valid one instead of reaching the engine malformed.
    collect: normalizeCollectConfig(row.collect),
    collectVersion: row.collectVersion ?? 0,
    updatedAt: row.updatedAt,
  };
}

/** The settings an agent carries — everything a save may write, and what a new agent copies. */
const AGENT_SETTINGS = [
  "businessName",
  "purpose",
  "tone",
  "timezone",
  "replyLanguage",
  "hours",
  "escalation",
  "capabilities",
  "voices",
  "greeting",
  "recordCalls",
  "autoEndCalls",
  "endCallDelaySeconds",
];

/**
 * The row a write targets: the named agent (must be this tenant's), or the default agent —
 * created on the first save, so a setup wizard needs no separate "create" step.
 */
async function targetRow(tenantId, agentId, db = prisma) {
  if (agentId) {
    const row = await db.agentConfig.findFirst({ where: { id: agentId, tenantId } });
    if (!row) throw new AgentNotFoundError(agentId);
    return row;
  }
  return ensureDefaultAgent(tenantId, db);
}

/**
 * The tenant's default agent row, created (with the placeholder name) if it has none yet.
 * Safe under a race: the unique default_for makes the second create fail, and it reads the winner.
 */
async function ensureDefaultAgent(tenantId, db = prisma) {
  const existing = await db.agentConfig.findUnique({ where: { defaultFor: tenantId } });
  if (existing) return existing;
  try {
    // businessName is the only required column, so a create has to put SOMETHING there —
    // an empty string would render as "Welcome to ." later.
    return await db.agentConfig.create({ data: { tenantId, defaultFor: tenantId, businessName: DEFAULTS.businessName } });
  } catch (err) {
    if (err?.code !== "P2002") throw err;
    return db.agentConfig.findUnique({ where: { defaultFor: tenantId } });
  }
}

/**
 * Update an agent's settings. Used by /api/agent-config (the partner's dashboard).
 *
 * @param {string} tenantId
 * @param {object} patch partial config; only provided keys are written
 * @param {{ agentId?: string|null }} [options] omitted → the default agent (created if missing)
 */
export async function saveAgentConfig(tenantId, patch, { agentId = null } = {}) {
  if (!tenantId) throw new Error("saveAgentConfig requires a tenantId");

  const data = {};
  for (const key of AGENT_SETTINGS) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }
  // Stored in its normalised form (international phone numbers, trimmed text): what is read
  // back is exactly what the transfer will dial.
  if (data.escalation !== undefined) data.escalation = normalizeHandoffConfig(data.escalation);
  if (data.greeting !== undefined) data.greeting = normalizeGreeting(data.greeting);

  const row = await targetRow(tenantId, agentId);
  // The dashboard language belongs to the tenant, so it is written to the default agent
  // whichever agent is being edited.
  if (patch.uiLocale !== undefined) {
    if (row.defaultFor) data.uiLocale = patch.uiLocale;
    else await prisma.agentConfig.update({ where: { id: (await ensureDefaultAgent(tenantId)).id }, data: { uiLocale: patch.uiLocale } });
  }
  const saved = Object.keys(data).length ? await prisma.agentConfig.update({ where: { id: row.id }, data }) : row;

  invalidateAgentConfig(tenantId);
  return getAgentConfig(tenantId, { agentId: saved.defaultFor ? null : saved.id, skipCache: true });
}


/**
 * Save what the agent collects. Separate from saveAgentConfig on purpose: this document is
 * validated by lib/collect/config.js validateCollectConfig and versioned, and a general
 * config edit must never be able to overwrite it half-way.
 *
 * @param {string} tenantId
 * @param {object} collect an already-validated collect config
 * @param {{ agentId?: string|null }} [options]
 */
export async function saveCollectConfig(tenantId, collect, { agentId = null } = {}) {
  if (!tenantId) throw new Error("saveCollectConfig requires a tenantId");
  const row = await targetRow(tenantId, agentId);
  const saved = await prisma.agentConfig.update({
    where: { id: row.id },
    data: { collect, collectVersion: { increment: 1 } },
  });
  invalidateAgentConfig(tenantId);
  return getAgentConfig(tenantId, { agentId: saved.defaultFor ? null : saved.id, skipCache: true });
}

// ── MANAGING AGENTS ─────────────────────────────────────────────────────────

/** What a list of agents shows — enough to pick one, never the whole configuration. */
function describeAgent(row) {
  return {
    id: row.id,
    name: row.name ?? "",
    businessName: row.businessName?.trim() || DEFAULTS.businessName,
    status: AGENT_STATUSES.includes(row.status) ? row.status : "active",
    isDefault: Boolean(row.defaultFor),
    replyLanguage: isReplyLanguage(row.replyLanguage) ? row.replyLanguage : DEFAULT_REPLY_LANGUAGE,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A tenant's agents: the default first, then by creation. Never empty: a tenant that has never
 * saved anything is listed with its default agent as it will be — `id: null`, built-in
 * defaults — WITHOUT writing a row (a read must not create one; the console's tenant box would
 * otherwise leave an agent behind for every half-typed tenant id). Its first save creates it.
 *
 * @param {string} tenantId
 * @param {{ includeArchived?: boolean }} [options]
 */
export async function listAgents(tenantId, { includeArchived = false } = {}) {
  if (!tenantId) throw new Error("listAgents requires a tenantId");
  const rows = await prisma.agentConfig.findMany({
    where: { tenantId, ...(includeArchived ? {} : { status: "active" }) },
    orderBy: { createdAt: "asc" },
  });
  const agents = rows.map(describeAgent).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  if (agents.some((a) => a.isDefault)) return agents;
  const unsaved = { id: null, name: "", businessName: DEFAULTS.businessName, status: "active", isDefault: true, replyLanguage: DEFAULTS.replyLanguage, createdAt: null, updatedAt: null };
  return [unsaved, ...agents];
}

/** Two active agents with the same name would be impossible to tell apart in a list. */
async function assertNameFree(tenantId, name, exceptId) {
  if (!name) return;
  const clash = await prisma.agentConfig.findFirst({
    where: { tenantId, status: "active", name: { equals: name, mode: "insensitive" }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new AgentRuleError("nameTaken", 409, { name });
}

function cleanName(name) {
  if (name === undefined || name === null) return "";
  if (typeof name !== "string") throw new AgentRuleError("nameInvalid");
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length > MAX_AGENT_NAME) throw new AgentRuleError("nameTooLong", 400, { max: MAX_AGENT_NAME });
  return trimmed;
}

/**
 * Add an agent to a tenant. It starts as a COPY of another agent's settings (`copyFrom`, an
 * agent id of this tenant; default: the default agent) — a new branch or line almost always
 * shares the business name, hours, voice and the people calls go to, and starting from a
 * blank agent would make the owner type all of it again. Everything is editable afterwards.
 *
 * KNOWLEDGE IS NOT COPIED (§6.28): the new agent uses every SHARED document automatically, and
 * none of the documents restricted to the agent it was copied from — a new branch must not
 * answer from the Dublin branch's page just because it started as a copy of Dublin.
 *
 * @param {string} tenantId
 * @param {{ name?: string, copyFrom?: string|null }} input
 * @returns {Promise<object>} the new agent, as listAgents describes it
 */
export async function createAgent(tenantId, { name, copyFrom = null } = {}) {
  if (!tenantId) throw new Error("createAgent requires a tenantId");
  const clean = cleanName(name);
  if (!clean) throw new AgentRuleError("nameRequired");

  const source = copyFrom ? await targetRow(tenantId, copyFrom) : await ensureDefaultAgent(tenantId);
  const active = await prisma.agentConfig.count({ where: { tenantId, status: "active" } });
  if (active >= MAX_AGENTS_PER_TENANT) throw new AgentRuleError("tooMany", 409, { max: MAX_AGENTS_PER_TENANT });
  const plan = await assertCanAddAgent(tenantId, { activeAgents: active });
  if (!plan.ok) throw new AgentRuleError("planLimit", plan.status ?? 403);
  await assertNameFree(tenantId, clean);

  const copied = {};
  for (const key of AGENT_SETTINGS) if (source[key] !== null && source[key] !== undefined) copied[key] = source[key];
  const row = await prisma.agentConfig.create({
    data: {
      tenantId,
      name: clean,
      ...copied,
      businessName: source.businessName || DEFAULTS.businessName,
      // The request checklist is copied too; its version starts again, it is a new document.
      collect: source.collect ?? undefined,
      collectVersion: source.collect ? 1 : 0,
    },
  });
  invalidateAgentConfig(tenantId);
  return describeAgent(row);
}

/**
 * Rename, archive / restore, or make an agent the default.
 *
 * Rules, each refused with a reason the owner can act on:
 *   - the default agent cannot be archived (make another one the default first) — something
 *     must always answer a request that names no agent;
 *   - an archived agent cannot become the default;
 *   - an agent that phone numbers still ring cannot be archived (move them first, §6.29) — a
 *     caller to that number would otherwise reach "not in service" with no warning to anyone;
 *   - restoring an agent counts against the agent limit.
 *
 * @param {string} tenantId
 * @param {string} agentId
 * @param {{ name?: string, status?: "active"|"archived", makeDefault?: boolean }} change
 * @returns {Promise<object>} the agent, as listAgents describes it
 */
export async function updateAgent(tenantId, agentId, change = {}) {
  if (!tenantId) throw new Error("updateAgent requires a tenantId");
  const row = await targetRow(tenantId, agentId);
  const data = {};

  if (change.status !== undefined) {
    if (!AGENT_STATUSES.includes(change.status)) throw new AgentRuleError("statusInvalid");
    if (change.status === "archived" && (row.defaultFor || change.makeDefault)) throw new AgentRuleError("archiveDefault", 409);
    if (change.status === "archived" && row.status !== "archived") {
      const numbers = await countNumbersForAgent(row.id);
      if (numbers) throw new AgentRuleError("hasNumbers", 409, { count: numbers });
    }
    if (change.status === "active" && row.status !== "active") {
      const active = await prisma.agentConfig.count({ where: { tenantId, status: "active" } });
      if (active >= MAX_AGENTS_PER_TENANT) throw new AgentRuleError("tooMany", 409, { max: MAX_AGENTS_PER_TENANT });
    }
    data.status = change.status;
  }
  if (change.name !== undefined) {
    const clean = cleanName(change.name);
    // The default agent may stay unnamed (it shows the business name); any other needs a name.
    if (!clean && !row.defaultFor) throw new AgentRuleError("nameRequired");
    data.name = clean;
  }
  if ((data.status ?? row.status) === "active") await assertNameFree(tenantId, data.name ?? row.name, row.id);

  let updated = Object.keys(data).length ? await prisma.agentConfig.update({ where: { id: row.id }, data }) : row;

  if (change.makeDefault && !updated.defaultFor) {
    if (updated.status !== "active") throw new AgentRuleError("defaultArchived", 409);
    // One transaction, old default cleared FIRST: default_for is unique, so setting the new one
    // before clearing the old would collide. The tenant's dashboard language moves with it.
    updated = await prisma.$transaction(async (tx) => {
      const current = await tx.agentConfig.findUnique({ where: { defaultFor: tenantId } });
      if (current) await tx.agentConfig.update({ where: { id: current.id }, data: { defaultFor: null } });
      return tx.agentConfig.update({
        where: { id: updated.id },
        data: { defaultFor: tenantId, ...(current ? { uiLocale: current.uiLocale } : {}) },
      });
    });
  }

  invalidateAgentConfig(tenantId);
  return describeAgent(updated);
}
