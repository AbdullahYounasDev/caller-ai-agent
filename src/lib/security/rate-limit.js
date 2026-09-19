/**
 * Sliding-window rate limiting for public channel endpoints.
 *
 * ⚠️ IN-PROCESS, AND THAT IS A REAL LIMITATION. Each Node instance keeps its own
 * counters, so N instances means a caller effectively gets N× the limit. That's
 * acceptable while this runs as one process; it is NOT acceptable once you scale
 * out or deploy serverless (where every cold start resets the window entirely).
 *
 * When you scale: move `hit()` to Redis (INCR + EXPIRE, or a sorted set for a
 * true sliding window). The call sites don't change — that's why every limit
 * goes through this one function.
 *
 * Why rate limit at all: every message costs an embedding call plus a generation
 * call against a tenant's quota. An unthrottled public endpoint is a way to bill
 * a business for traffic it never had.
 */

const buckets = new Map(); // key -> number[] of request timestamps

// Bounded cleanup so a long-running process doesn't accumulate a bucket per
// visitor forever. Cheap: it only runs when the map is already large.
const MAX_BUCKETS = 10_000;

/**
 * @param {object} args
 * @param {string} args.key    what's being limited, e.g. "widget:pk_abc" or "conv:uuid"
 * @param {number} args.limit  max requests allowed in the window
 * @param {number} args.windowMs
 * @returns {{ok: true, remaining: number} | {ok: false, retryAfterSec: number}}
 */
export function hit({ key, limit, windowMs }) {
  const now = Date.now();
  const cutoff = now - windowMs;

  let timestamps = buckets.get(key);
  if (!timestamps) {
    timestamps = [];
    buckets.set(key, timestamps);
  }

  // Drop anything that fell out of the window. Mutating in place keeps this a
  // single array per key rather than reallocating on every request.
  while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();

  if (timestamps.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
    return { ok: false, retryAfterSec };
  }

  timestamps.push(now);

  if (buckets.size > MAX_BUCKETS) sweep(cutoff);

  return { ok: true, remaining: limit - timestamps.length };
}

function sweep(cutoff) {
  for (const [key, timestamps] of buckets) {
    if (!timestamps.length || timestamps[timestamps.length - 1] <= cutoff) {
      buckets.delete(key);
    }
  }
}

/** Test/dev helper — clears all counters. */
export function resetRateLimits() {
  buckets.clear();
}

/**
 * The limits for the widget channel.
 *
 * Two layers on purpose:
 *  - PER KEY catches "someone scraped a tenant's key and is hammering it", but
 *    is necessarily loose, because a popular site legitimately has many
 *    simultaneous visitors sharing one key.
 *  - PER CONVERSATION catches the actual abuse shape — one script looping
 *    messages — and can be tight, because no real human types 20 messages a
 *    minute. This is the one that does the useful work.
 */
export const WIDGET_LIMITS = {
  perKey: { limit: 120, windowMs: 60_000 },
  perConversation: { limit: 20, windowMs: 60_000 },
};
