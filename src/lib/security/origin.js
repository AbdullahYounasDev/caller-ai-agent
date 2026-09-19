import { normalizeOrigin } from "@/lib/tenant/registry";

/**
 * Origin checking + CORS for public channel endpoints.
 *
 * The widget runs on OTHER PEOPLE'S websites, so these endpoints must be
 * cross-origin by design. That makes the origin allowlist the thing standing
 * between a tenant's key and anyone who copies it out of their page source.
 *
 * The key alone is not a secret (it's in public HTML). Key + allowed origin is
 * what actually scopes access — which is why an empty allowlist must mean
 * "same-origin only", never "anyone".
 */

/**
 * @param {Request} request
 * @param {string[]} allowedOrigins from the WidgetKey row
 * @returns {{ok: true, origin: string|null} | {ok: false, status: number, error: string}}
 */
export function checkOrigin(request, allowedOrigins) {
  const rawOrigin = request.headers.get("origin");

  // No Origin header at all: not a browser (curl, a server, a native mobile
  // app's HTTP client). Browsers always send it on a cross-origin POST, so this
  // can't be a cross-site page pretending otherwise — a cross-site request
  // cannot suppress its own Origin.
  //
  // We allow it, because native mobile apps are a real, intended client and
  // have no origin to send. The key + rate limiting are what protect this path.
  if (!rawOrigin) return { ok: true, origin: null };

  const origin = normalizeOrigin(rawOrigin);
  if (!origin) return { ok: false, status: 403, error: "Invalid Origin header", origin: null };

  // Empty allowlist = same-origin only. This is the state a key is in right
  // after it's created, before the business says where the widget will live —
  // failing closed means a leaked new key is useless, rather than usable
  // everywhere until someone remembers to lock it down.
  if (!allowedOrigins || allowedOrigins.length === 0) {
    const self = normalizeOrigin(request.url);
    if (self && origin === self) return { ok: true, origin };
    return { ok: false, status: 403, origin };
  }

  if (allowedOrigins.includes(origin)) return { ok: true, origin };

  // `origin` is returned on rejection too, so the caller can still send CORS
  // headers for the 403 itself. That is deliberate: the body of a rejection
  // contains no tenant data, and without readable CORS headers the widget shows
  // a generic "network error" for what is really "add your domain in the
  // dashboard" — an install problem nobody can diagnose from the outside.
  // It does NOT grant access; the request is still refused.
  return { ok: false, status: 403, origin };
}

/**
 * CORS headers for an ALLOWED origin.
 *
 * Note we echo the specific origin rather than sending "*": the widget will
 * eventually need credentialed requests, and `*` is incompatible with those.
 * Echoing also means the browser enforces the allowlist for us on every
 * subsequent request, not just the preflight.
 *
 * @param {string|null} origin
 */
export function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // Without this, a CDN or browser cache can serve one tenant's CORS decision
    // to a request from a different origin.
    Vary: "Origin",
    "Access-Control-Max-Age": "86400",
  };
}
