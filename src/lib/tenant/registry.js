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
 * WHEN TELEPHONY LANDS, the identity question returns in a different shape:
 * an inbound call identifies its tenant by the NUMBER THAT WAS DIALLED, and
 * that mapping is resolved HERE, from a verified provider webhook — never from
 * anything the caller supplies. See the Twilio section in CLAUDE.md.
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
