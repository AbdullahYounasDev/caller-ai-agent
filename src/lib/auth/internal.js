/**
 * Guard for INTERNAL, server-to-server endpoints — the ones the partner's
 * dashboard backend calls to read and write agent configuration.
 *
 * This is NOT the auth that will protect public channel endpoints (the widget,
 * webhooks). Those need per-tenant public keys, an origin allowlist and rate
 * limiting — that's Phase 1b. Two different problems:
 *   - this file: "is this our partner's server?"      → one shared secret
 *   - Phase 1b:  "which tenant is this browser?"      → per-tenant public key
 *
 * Never use this to authorize a request that reached us from a browser: the
 * secret would have to ship to the client to get there.
 */

const HEADER = "x-internal-key";

/**
 * @param {Request} request
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function checkInternalAuth(request) {
  const expected = process.env.INTERNAL_API_KEY;

  if (!expected) {
    // Fail CLOSED in production. A config-write endpoint that silently accepts
    // everyone because an env var wasn't set is exactly the kind of thing that
    // ships unnoticed — so it has to be loud and fatal off the dev machine.
    if (process.env.NODE_ENV === "production") {
      return {
        ok: false,
        status: 500,
        error: "INTERNAL_API_KEY is not configured on the server",
      };
    }
    console.warn(
      "[internal-auth] INTERNAL_API_KEY not set — allowing request in development only."
    );
    return { ok: true };
  }

  const provided = request.headers.get(HEADER);
  if (!provided || !timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, error: "Invalid or missing internal API key" };
  }

  return { ok: true };
}

/**
 * Constant-time string compare. A plain `===` on a secret leaks its prefix
 * through response timing; it's a cheap habit to keep even at this scale.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
