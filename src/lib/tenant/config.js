import { prisma } from "@/lib/db";

/**
 * THE TENANT CONFIG SEAM.
 *
 * Every part of the AI engine that needs to know anything about a business —
 * its name, persona, languages, what the agent is allowed to do, how the widget
 * looks — goes through getAgentConfig(). One function, one shape, one cache.
 *
 * Why a seam at all: the partner owns tenants/users/auth/plans/billing in the
 * `tenant_core` schema. If any of that ever has to be read here, it gets fetched
 * INSIDE this file and merged into the object below — so the rest of the codebase
 * never learns where a given field came from, and swapping the source is a
 * one-file change instead of a grep-and-pray.
 */

// Shape returned when a tenant has no agent_configs row yet. An un-onboarded
// tenant must still get a working (if generic) agent rather than a 500 — the
// widget can be embedded before anyone finishes the setup wizard.
const DEFAULTS = {
  businessName: "this business",
  purpose: "",
  tone: "professional",
  timezone: "UTC",
  defaultLocale: "en",
  languages: ["en"],
  hours: null,
  escalation: null,
  capabilities: {},
  widget: {},
};

// Widget theme defaults. Kept here rather than in the widget so an un-themed
// tenant still renders something deliberate instead of unstyled HTML.
const WIDGET_DEFAULTS = {
  logoUrl: null,
  primaryColor: "#171717",
  position: "bottom-end", // logical, not bottom-right — RTL locales flip it (ar, ur)
  greeting: null, // null = fall back to the translated default greeting
  launcherIcon: "chat",
};

export const SUPPORTED_LOCALES = ["en", "it", "ar", "ur"];
export const RTL_LOCALES = ["ar", "ur"];

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
 * would otherwise reach the model or the widget unchecked.
 * @param {object|null} row
 */
function normalizeConfig(row) {
  if (!row) return { ...DEFAULTS, widget: { ...WIDGET_DEFAULTS }, exists: false };

  const languages =
    Array.isArray(row.languages) && row.languages.length
      ? row.languages.filter((l) => SUPPORTED_LOCALES.includes(l))
      : DEFAULTS.languages;

  // A defaultLocale the tenant hasn't actually enabled would leave the agent
  // replying in a language the business can't read in its own transcripts.
  const defaultLocale = languages.includes(row.defaultLocale)
    ? row.defaultLocale
    : (languages[0] ?? DEFAULTS.defaultLocale);

  return {
    exists: true,
    tenantId: row.tenantId,
    businessName: row.businessName?.trim() || DEFAULTS.businessName,
    purpose: row.purpose ?? DEFAULTS.purpose,
    tone: row.tone ?? DEFAULTS.tone,
    timezone: row.timezone ?? DEFAULTS.timezone,
    defaultLocale,
    languages: languages.length ? languages : DEFAULTS.languages,
    hours: row.hours ?? null,
    escalation: row.escalation ?? null,
    capabilities: row.capabilities ?? {},
    widget: { ...WIDGET_DEFAULTS, ...(row.widget ?? {}) },
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
    "defaultLocale",
    "languages",
    "hours",
    "escalation",
    "capabilities",
    "widget",
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
