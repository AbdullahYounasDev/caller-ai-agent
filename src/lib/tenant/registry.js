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
 * ★ THE FUNCTION TO CHANGE WHEN tenant_core LANDS ★
 *
 * Today every tenant is serviceable. Once the partner has tenants, plans and
 * billing, this is where "is this account active, unsuspended and in quota?"
 * gets asked — one cached lookup, returning a reason when not.
 *
 * It is already called on the paths that matter, so wiring it up later is a
 * function body rather than a refactor.
 *
 * @param {string} tenantId
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function assertTenantServiceable(tenantId) {
  if (!tenantId) return { ok: false, status: 400, error: "Unknown tenant" };

  // TODO (when tenant_core exists): look the tenant up and return
  //   { ok: false, status: 403, error: "This account is suspended" }      — billing
  //   { ok: false, status: 429, error: "Monthly message limit reached" }  — quota
  return { ok: true };
}
