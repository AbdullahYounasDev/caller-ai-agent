/**
 * The phone-number lookup's cache (§6.29), in its own module so the seam that READS through it
 * (tenant/registry.js) and the store that CHANGES numbers (standins/numbers.js) share it without
 * importing each other.
 *
 * Every inbound call starts with this lookup, so it is cached — briefly. Per process, like the
 * config cache (tenant/config.js): a change made through another process is seen after at most
 * TTL. 30 s is short enough that re-linking a number to another agent takes effect for the next
 * caller in practice; do not raise it to "fix" a staleness report — invalidate instead.
 */
const TTL_MS = 30_000;
const routes = new Map(); // e164 -> { value, expiresAt }

export function readRoute(e164, now = Date.now()) {
  const hit = routes.get(e164);
  return hit && hit.expiresAt > now ? hit.value : undefined;
}

export function rememberRoute(e164, value, now = Date.now()) {
  routes.set(e164, { value, expiresAt: now + TTL_MS });
}

/** Forget one number's route, or every route when called with none. */
export function forgetRoute(e164) {
  if (e164) routes.delete(e164);
  else routes.clear();
}
