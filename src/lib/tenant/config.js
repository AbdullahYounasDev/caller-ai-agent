import { prisma } from "@/lib/db";
import {
  SUPPORTED_LOCALES,
  RTL_LOCALES,
  DEFAULT_REPLY_LANGUAGE,
  isReplyLanguage,
} from "@/lib/i18n";
import { emptyCollectConfig, normalizeCollectConfig } from "@/lib/collect/config";

/**
 * THE TENANT CONFIG SEAM.
 *
 * Every part of the AI engine that needs to know anything about a business —
 * its name, persona, language and what the agent is allowed to do — goes
 * through getAgentConfig(). One function, one shape, one cache.
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
  escalation: null,
  capabilities: {},
  // { [spokenLanguage]: voiceId } — empty means every language uses its default voice
  // (lib/voice/speech/voices.js voiceFor()).
  voices: {},
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
const cache = new Map(); // tenantId -> { value, expiresAt }

/**
 * Load a tenant's agent configuration, merged over defaults and cached.
 *
 * @param {string} tenantId
 * @param {{ skipCache?: boolean }} [options]
 * @returns {Promise<object>} never null — falls back to DEFAULTS
 */
export async function getAgentConfig(tenantId, { skipCache = false } = {}) {
  if (!tenantId) throw new Error("getAgentConfig requires a tenantId");

  if (!skipCache) {
    const hit = cache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const row = await prisma.agentConfig.findUnique({ where: { tenantId } });
  const value = normalizeConfig(row);

  cache.set(tenantId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Drop a tenant's cached config. Call this from anywhere that WRITES config,
 * so a business sees its own edit take effect immediately instead of waiting
 * out the TTL — that delay reads as "the dashboard is broken".
 * @param {string} [tenantId] omit to clear every tenant
 */
export function invalidateAgentConfig(tenantId) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/**
 * Merge a DB row (or null) over the defaults and sanity-check the values that
 * would otherwise reach the model unchecked.
 * @param {object|null} row
 */
function normalizeConfig(row) {
  if (!row) return { ...DEFAULTS, collect: emptyCollectConfig(), exists: false };

  return {
    exists: true,
    tenantId: row.tenantId,
    businessName: row.businessName?.trim() || DEFAULTS.businessName,
    purpose: row.purpose ?? DEFAULTS.purpose,
    tone: row.tone ?? DEFAULTS.tone,
    timezone: row.timezone ?? DEFAULTS.timezone,
    // INTERFACE language: every screen the business owner reads.
    uiLocale: isSupported(row.uiLocale) ? row.uiLocale : DEFAULTS.uiLocale,
    // What the AGENT replies in: "en" or "ur" (it always UNDERSTANDS both). A value
    // left over from the days of "auto"/Italian degrades to the default instead of
    // reaching the prompt.
    replyLanguage: isReplyLanguage(row.replyLanguage)
      ? row.replyLanguage
      : DEFAULT_REPLY_LANGUAGE,
    hours: row.hours ?? null,
    escalation: row.escalation ?? null,
    capabilities: row.capabilities ?? {},
    voices: row.voices && typeof row.voices === "object" && !Array.isArray(row.voices) ? row.voices : {},
    // Normalized on every read: a stored document that has drifted from the schema degrades
    // to the nearest valid one instead of reaching the engine malformed.
    collect: normalizeCollectConfig(row.collect),
    collectVersion: row.collectVersion ?? 0,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create or update a tenant's config. Used by /api/agent-config (the partner's
 * dashboard) — upsert rather than update so the first save from the setup wizard
 * doesn't need a separate "create tenant config" step.
 *
 * @param {string} tenantId
 * @param {object} patch partial config; only provided keys are written
 */
export async function saveAgentConfig(tenantId, patch) {
  if (!tenantId) throw new Error("saveAgentConfig requires a tenantId");

  const writable = [
    "businessName",
    "purpose",
    "tone",
    "timezone",
    "uiLocale",
    "replyLanguage",
    "hours",
    "escalation",
    "capabilities",
    "voices",
  ];

  const data = {};
  for (const key of writable) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }

  const row = await prisma.agentConfig.upsert({
    where: { tenantId },
    // businessName is the only required column, so a create that omits it has to
    // put SOMETHING there — an empty string would render as "Welcome to ." later.
    create: { tenantId, businessName: DEFAULTS.businessName, ...data },
    update: data,
  });

  invalidateAgentConfig(tenantId);
  return normalizeConfig(row);
}


/**
 * Save what the agent collects. Separate from saveAgentConfig on purpose: this document is
 * validated by lib/collect/config.js validateCollectConfig and versioned, and a general
 * config edit must never be able to overwrite it half-way.
 *
 * @param {string} tenantId
 * @param {object} collect an already-validated collect config
 */
export async function saveCollectConfig(tenantId, collect) {
  if (!tenantId) throw new Error("saveCollectConfig requires a tenantId");
  const row = await prisma.agentConfig.upsert({
    where: { tenantId },
    create: { tenantId, businessName: DEFAULTS.businessName, collect, collectVersion: 1 },
    update: { collect, collectVersion: { increment: 1 } },
  });
  invalidateAgentConfig(tenantId);
  return normalizeConfig(row);
}
