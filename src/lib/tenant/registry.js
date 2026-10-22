import { toE164, routeForNumber } from "@/lib/telephony/routing";
import { readRoute, rememberRoute } from "@/lib/telephony/route-cache";
import { findNumberForRouting } from "@/lib/standins/numbers";

/**
 * ███ THE TENANT RESOLUTION SEAM ███
 *
 * "Which tenant is this request for, and may that tenant be served?"
 *
 * ── HOW TO SWAP THIS WHEN tenant_core EXISTS ──────────────────────────────
 * Edit exactly one function — `assertTenantServiceable()` — to ask the
 * partner's tables whether the tenant is active, not suspended, and inside its
 * plan quota. Nothing else in the codebase moves, because nothing else in the
 * codebase talks to tenant_core.
 *
 * Do NOT let tenant-state checks leak into route handlers. The moment they do,
 * adding a billing state means hunting through every channel, and one of them
 * will be missed — which is the day a suspended tenant keeps being served.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * WHAT USED TO BE HERE: public widget keys (`pk_…`), an origin allowlist, and
 * key provisioning. All of it was for the embeddable browser widget, which has
 * been removed. Today every caller is internal — the dashboard and the test
 * chat, both behind INTERNAL_API_KEY — so a tenant id arrives as a trusted
 * query parameter rather than something resolved from a public credential.
 *
 * TELEPHONY: an inbound call identifies its tenant — and its AGENT — by the NUMBER
 * THAT WAS DIALLED, resolved HERE by resolveDialledNumber() (bottom of this file,
 * CLAUDE.md §6.29) from a verified provider webhook — never from anything the
 * caller supplies.
 */

/**
 * SHAPE OF A TENANT ID, decided ONCE here rather than left to whatever a query
 * param happens to contain. `tenantId` ends up in two places that care what
 * characters it holds: a Prisma parameter (safe regardless, Prisma always
 * parameterizes) and a Cloudinary FOLDER PATH built by string interpolation
 * (`storage.js`: `` `caller-ai-agent/${tenantId}` ``, not safe by construction).
 * A tenantId containing `/` or `..` could put an upload in a folder other than
 * the one intended. Letters, digits, `-` and `_` only — every real tenant id
 * this project has ever used (uuids, partner slugs, this file's own test
 * fixtures) fits that easily, and nothing legitimate needs a path separator.
 */
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** @param {unknown} tenantId */
export function isValidTenantId(tenantId) {
  return typeof tenantId === "string" && TENANT_ID_PATTERN.test(tenantId);
}

/**
 * ★ THE FUNCTION TO CHANGE WHEN tenant_core LANDS ★
 *
 * Today every syntactically-valid tenant is serviceable. Once the partner has
 * tenants, plans and billing, this is where "is this account active,
 * unsuspended and in quota?" gets asked — one cached lookup, returning a
 * reason when not.
 *
 * @param {string} tenantId
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function assertTenantServiceable(tenantId) {
  if (!isValidTenantId(tenantId)) {
    return { ok: false, status: 400, error: "Unknown tenant" };
  }

  // TODO (when tenant_core exists): look the tenant up and return
  //   { ok: false, status: 403, error: "This account is suspended" }      — billing
  //   { ok: false, status: 429, error: "Monthly message limit reached" }  — quota
  return { ok: true };
}

/**
 * ROUTE-FACING WRAPPER. This is the "one small shared helper" every route that
 * serves or mutates a tenant's data calls — so tenant-state logic (§4) lives
 * here exactly once instead of each route growing its own copy of "is this
 * tenant OK?".
 *
 * Translated by STATUS CODE, not by matching `assertTenantServiceable()`'s raw
 * `error` string. That string is free to change — or grow new reasons — inside
 * the one function above this comment says to edit, without this wrapper, or
 * any of its callers, needing a matching edit.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {(key: string, opts?: object) => string} args.tr bound translator
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function requireServiceableTenant({ tenantId, tr }) {
  const verdict = await assertTenantServiceable(tenantId);
  if (verdict.ok) return verdict;

  const key =
    verdict.status === 403
      ? "validation:tenant.suspended"
      : verdict.status === 429
        ? "validation:tenant.quotaExceeded"
        : "validation:tenantId.invalid";

  return { ok: false, status: verdict.status, error: tr(key) };
}

// ── AGENTS (CLAUDE.md §6.27) ─────────────────────────────────────────────────

/**
 * ★ WHERE A PLAN'S AGENT LIMIT GOES ★ — the backend decides how many agents a plan includes.
 * Today every tenant may add agents up to the engine's own safety cap (config.js
 * MAX_AGENTS_PER_TENANT). Same shape and same "edit only this function" rule as
 * assertTenantServiceable(). Called by tenant/config.js createAgent() — never by a route.
 *
 * @param {string} tenantId
 * @param {{activeAgents: number}} usage
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function assertCanAddAgent(tenantId, { activeAgents }) {
  void tenantId;
  void activeAgents;
  // TODO (when plans exist): { ok: false, status: 403, error: "Your plan includes N agents" }
  return { ok: true };
}

// ── PHONE NUMBERS (CLAUDE.md §6.29) ─────────────────────────────────────────

/**
 * ★ THE PHONE-NUMBER LOOKUP — "this number was dialled: which tenant, which agent?" ★
 *
 * An inbound call identifies its business by the NUMBER THAT WAS DIALLED, and nothing the caller
 * supplies (§9.2). Today the numbers come from the stand-in store (standins/numbers.js); when the
 * backend's lookup exists (`GET /internal/numbers/{e164}` → { tenantId, agentId }, handoff B11)
 * the read inside this function changes and NOTHING ELSE does — the phone webhook, the console's
 * "call as if dialling" and the tests all come through here.
 *
 * Refuses (never guesses) a number that is malformed, unknown, released, not linked to an agent,
 * linked to an archived agent, or whose business may not be served. The route is cached ~30 s
 * per process (telephony/route-cache.js); a change made through standins/numbers.js drops it at
 * once. Serviceability is re-checked on EVERY call, never cached, so a suspension takes effect
 * immediately.
 *
 * @param {string} dialled the number as the provider sent it ("+442071234567")
 * @param {{skipCache?: boolean}} [options]
 * @returns {Promise<{ok: true, tenantId: string, agentId: string, numberId: string, e164: string}
 *   | {ok: false, reason: string, e164?: string, tenantId?: string, numberId?: string}>}
 */
export async function resolveDialledNumber(dialled, { skipCache = false } = {}) {
  const parsed = toE164(dialled);
  if (!parsed.ok) return { ok: false, reason: "invalid_number" };
  const e164 = parsed.value;

  let route = skipCache ? undefined : readRoute(e164);
  if (route === undefined) {
    route = routeForNumber(await findNumberForRouting(e164));
    rememberRoute(e164, route);
  }
  if (!route.ok) return { ...route, e164 };

  const serviceable = await assertTenantServiceable(route.tenantId);
  if (!serviceable.ok) return { ok: false, reason: "tenant_unserviceable", e164, tenantId: route.tenantId, numberId: route.numberId };
  return { ...route, e164 };
}
