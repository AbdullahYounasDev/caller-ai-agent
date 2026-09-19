import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * ███ THE TENANT RESOLUTION SEAM ███
 *
 * "Which tenant is this request for, and is that tenant allowed to be served?"
 * Every public channel endpoint answers that question HERE and nowhere else.
 *
 * ── HOW TO SWAP THIS WHEN tenant_core EXISTS ──────────────────────────────
 * Today a widget key resolves to a tenant id and we trust it. That is the ONLY
 * thing that has to change. When the partner's tables land, edit exactly one
 * function — `assertTenantServiceable()` at the bottom of this file — to ask
 * tenant_core whether the tenant is active, not suspended, not over its plan
 * quota. Nothing else in the codebase moves, because nothing else in the
 * codebase calls tenant_core.
 *
 * Do NOT let "is this tenant allowed" checks leak into route handlers. The
 * moment that happens, adding a billing state means hunting through every
 * channel adapter, and one of them will be missed.
 * ──────────────────────────────────────────────────────────────────────────
 */

const KEY_PREFIX = "pk_";

// Same reasoning as the config cache: this is read on every single message.
// Per-process, so a revoked key stays usable for up to TTL on instances that
// didn't handle the revoke — that's why revocation is also checked against
// `active`/`revokedAt` at read time rather than only at cache-fill time.
const CACHE_TTL_MS = 30_000;
const cache = new Map(); // publicKey -> { value, expiresAt }

/**
 * Resolve a public widget key to the tenant behind it.
 *
 * @param {string} publicKey
 * @returns {Promise<{tenantId: string, allowedOrigins: string[], keyId: string} | null>}
 *          null when the key is unknown, revoked or inactive — callers must NOT
 *          distinguish these in their response (see the 401 in the widget route).
 */
export async function resolveTenantByPublicKey(publicKey) {
  if (!publicKey || typeof publicKey !== "string") return null;

  const devTenant = resolveDevKey(publicKey);
  if (devTenant) return devTenant;

  if (!publicKey.startsWith(KEY_PREFIX)) return null;

  const hit = cache.get(publicKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const row = await prisma.widgetKey.findUnique({ where: { publicKey } });

  const value =
    row && row.active && !row.revokedAt
      ? {
          keyId: row.id,
          tenantId: row.tenantId,
          allowedOrigins: row.allowedOrigins ?? [],
        }
      : null;

  cache.set(publicKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * DEV-ONLY ESCAPE HATCH.
 *
 * Set DEV_WIDGET_KEY + DEV_WIDGET_TENANT_ID in .env and that key resolves
 * without any database row, so you can work on the widget before seeding
 * anything. Hard-gated on NODE_ENV: in production this function always returns
 * null, no matter what is in the environment. A "temporary" auth bypass that
 * can be switched on in production by setting an env var is how real breaches
 * happen — the gate is the whole point, don't relax it.
 */
function resolveDevKey(publicKey) {
  if (process.env.NODE_ENV === "production") return null;

  const devKey = process.env.DEV_WIDGET_KEY;
  const devTenantId = process.env.DEV_WIDGET_TENANT_ID;
  if (!devKey || !devTenantId || publicKey !== devKey) return null;

  return {
    keyId: "dev",
    tenantId: devTenantId,
    // Empty = same-origin only, which is all a local harness needs.
    allowedOrigins: [],
  };
}

/** Drop a cached key — call after revoking or editing one. */
export function invalidateWidgetKey(publicKey) {
  if (publicKey) cache.delete(publicKey);
  else cache.clear();
}

/**
 * Generate + store a new widget key for a tenant.
 * Called by /api/widget-keys, which the partner's dashboard hits on onboarding.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string[]} [args.allowedOrigins]
 * @param {string} [args.label]
 */
export async function createWidgetKey({ tenantId, allowedOrigins = [], label }) {
  if (!tenantId) throw new Error("createWidgetKey requires a tenantId");

  // 32 random bytes. This value ends up in public HTML, so it isn't a secret —
  // but it must be unguessable, or anyone could burn a competitor's quota.
  const publicKey = `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;

  const row = await prisma.widgetKey.create({
    data: {
      tenantId,
      publicKey,
      allowedOrigins: allowedOrigins.map(normalizeOrigin).filter(Boolean),
      label: label ?? null,
    },
  });

  return serializeKey(row);
}

/** @param {string} tenantId */
export async function listWidgetKeys(tenantId) {
  const rows = await prisma.widgetKey.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(serializeKey);
}

/**
 * Revoke a key. Kept as a soft delete (`revokedAt`) rather than a row delete so
 * a business can see that a key existed and when it stopped working — "the
 * widget went blank last Tuesday" is unanswerable if the row is gone.
 */
export async function revokeWidgetKey({ tenantId, keyId }) {
  const row = await prisma.widgetKey.findUnique({ where: { id: keyId } });
  // Scoped by tenantId as well as id: never let one tenant revoke another's key
  // just by guessing a uuid.
  if (!row || row.tenantId !== tenantId) return null;

  const updated = await prisma.widgetKey.update({
    where: { id: keyId },
    data: { active: false, revokedAt: new Date() },
  });

  invalidateWidgetKey(updated.publicKey);
  return serializeKey(updated);
}

/**
 * Update the origin allowlist for a key.
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.keyId
 * @param {string[]} args.allowedOrigins
 */
export async function setAllowedOrigins({ tenantId, keyId, allowedOrigins }) {
  const row = await prisma.widgetKey.findUnique({ where: { id: keyId } });
  if (!row || row.tenantId !== tenantId) return null;

  const updated = await prisma.widgetKey.update({
    where: { id: keyId },
    data: { allowedOrigins: allowedOrigins.map(normalizeOrigin).filter(Boolean) },
  });

  invalidateWidgetKey(updated.publicKey);
  return serializeKey(updated);
}

/**
 * Record that a key was used, at most once a minute per process. Without the
 * throttle this would be a database write on every single chat message, to
 * store a value nobody reads in real time.
 */
const lastTouch = new Map();
const TOUCH_INTERVAL_MS = 60_000;

export function touchWidgetKey(keyId) {
  if (!keyId || keyId === "dev") return;

  const now = Date.now();
  if ((lastTouch.get(keyId) ?? 0) + TOUCH_INTERVAL_MS > now) return;
  lastTouch.set(keyId, now);

  // Deliberately not awaited: a analytics-grade write must never add latency to
  // a customer's reply, and must never fail the request if it errors.
  prisma.widgetKey
    .update({ where: { id: keyId }, data: { lastUsedAt: new Date() } })
    .catch((err) => console.error("touchWidgetKey failed:", err));
}

/**
 * ★ THE FUNCTION TO CHANGE WHEN tenant_core LANDS ★
 *
 * Right now a resolvable key is sufficient: if the key exists and isn't revoked,
 * we serve the tenant. Once the partner has tenants/plans/billing, this is where
 * "is this tenant active, unsuspended and inside its quota?" gets asked — one
 * query into tenant_core, cached, throwing or returning a reason when not.
 *
 * It is called on every public request already, so wiring it up later is a body
 * change in this function and nothing else.
 *
 * @param {string} tenantId
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function assertTenantServiceable(tenantId) {
  if (!tenantId) return { ok: false, status: 401, error: "Unknown tenant" };

  // TODO (when tenant_core exists): look the tenant up, and return
  //   { ok: false, status: 403, error: "This account is suspended" }      — billing
  //   { ok: false, status: 429, error: "Monthly message limit reached" }  — quota
  // Until then every resolvable key is serviceable.
  return { ok: true };
}

/**
 * Normalize to a bare origin: "https://acme.com/contact?x=1" -> "https://acme.com".
 * Comparing raw strings would mean "https://acme.com" and "https://acme.com/"
 * are different allowlist entries, and a business would swear it added theirs.
 */
export function normalizeOrigin(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

function serializeKey(row) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    publicKey: row.publicKey,
    allowedOrigins: row.allowedOrigins ?? [],
    label: row.label,
    active: row.active,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}
