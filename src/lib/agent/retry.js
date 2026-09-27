/**
 * Retry for LLM provider calls. Shared by every provider — extracted from
 * gemini.js when OpenRouter was added, because two copies of a backoff policy
 * drift and the second one always ends up retrying something it shouldn't.
 *
 * NOT speculative hardening. During live runs, Gemini returned 503 "high demand"
 * on roughly one call in five, and OpenRouter's free Gemma pool returns 429
 * "temporarily rate-limited upstream" for long stretches. Without a retry each
 * of those reaches a real customer as "something went wrong" mid-conversation.
 */

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/**
 * A 429 means two very different things and only one is worth retrying:
 *   - a short rate limit: clears in seconds, retry is exactly right
 *   - an exhausted daily/monthly QUOTA: will not clear for hours, so retrying
 *     just makes a customer wait longer for the same failure
 *
 * Seen in practice on a Gemini free-tier key capped at 20 requests/day. Fail
 * fast so the log names the real cause instead of burying it under retries.
 */
export function isQuotaExhausted(err) {
  const text = `${err?.message ?? ""}`;
  return (
    text.includes("RESOURCE_EXHAUSTED") ||
    text.includes("exceeded your current quota") ||
    // OpenRouter's wording when an account is out of credits, as opposed to the
    // shared free pool being momentarily busy — which IS worth retrying.
    text.includes("requires more credits") ||
    text.includes("Insufficient credits")
  );
}

/**
 * @param {() => Promise<T>} operation
 * @param {string} label used in logs, e.g. "openrouter:chat"
 * @param {{attempts?: number}} [options]
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(operation, label, { attempts = MAX_ATTEMPTS } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const status = err?.status ?? err?.code;
      if (!RETRYABLE_STATUSES.has(status) || attempt === attempts) throw err;

      if (status === 429 && isQuotaExhausted(err)) {
        console.error(
          `[llm] ${label} hit an account QUOTA limit, not a transient rate limit — ` +
            "not retrying. Check the plan/billing for this key."
        );
        throw err;
      }

      // Exponential backoff with jitter. The jitter matters under real load:
      // without it, every request that failed in the same spike retries at the
      // same instant and recreates the spike.
      const delay = 300 * 2 ** (attempt - 1) + Math.random() * 200;
      console.warn(
        `[llm] ${label} failed with ${status}, retrying in ${Math.round(delay)}ms ` +
          `(attempt ${attempt}/${attempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/** True when the failure is the provider's fault, so another provider may work. */
export function isProviderFailure(err) {
  const status = err?.status ?? err?.code;
  return RETRYABLE_STATUSES.has(status) || status === 401 || status === 403 || status === 404;
}
