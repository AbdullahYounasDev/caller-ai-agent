/**
 * A CIRCUIT BREAKER and a TIMEOUT, for an OPTIONAL model call on the hot path.
 *
 * The follow-up rewrite (§6.19) is a search-quality nicety, not something a reply
 * depends on. When the provider is degraded — quota gone, a 503 spell, a hung
 * connection — every triggered turn used to pay the full rewrite budget (3s) just to
 * learn, again, that it would fail, and then fall back to the raw message. On a phone
 * call that is 3 seconds of dead air per turn for nothing. After N failures IN A ROW
 * the breaker stops asking for a cool-down window and the caller fails soft at once.
 *
 *   CLOSED     calls go through; consecutive failures are counted, a success resets it
 *   OPEN       calls are refused instantly until the cool-down ends
 *   HALF-OPEN  after the cool-down exactly ONE probe call is let through. Success →
 *              CLOSED. Failure → OPEN again for another full cool-down. Concurrent
 *              callers during the probe are refused, so a recovering provider is
 *              probed by one request, not stampeded by every turn at once.
 *
 * Pure and clock-injectable: nothing here reads a global except the default `now`,
 * so the state machine is tested with a fake clock (tests/breaker.test.mjs).
 *
 * In-process state, like the rate limiter and the job queue (§8 limitation 9): with N
 * server instances each has its own breaker, which only costs each of them its own N
 * failures before it stops asking.
 */

export class CircuitOpenError extends Error {
  constructor(retryInMs) {
    super(`circuit open — skipping the call for another ${Math.ceil(retryInMs / 1000)}s`);
    this.name = "CircuitOpenError";
    this.retryInMs = retryInMs;
  }
}

export class CallTimeoutError extends Error {
  constructor(ms) {
    super(`timed out after ${ms}ms`);
    this.name = "CallTimeoutError";
  }
}

/**
 * @param {object} options
 * @param {number} options.threshold consecutive counted failures that open the circuit
 * @param {number} options.cooldownMs how long it stays open before one probe is allowed
 * @param {() => number} [options.now] clock, injectable for tests
 */
export function createCircuitBreaker({ threshold, cooldownMs, now = () => Date.now() }) {
  if (!(threshold >= 1) || !(cooldownMs >= 0)) throw new Error("breaker needs threshold >= 1 and cooldownMs >= 0");
  let state = "closed";
  let failures = 0;
  let openUntil = 0;
  let probing = false;

  return {
    /**
     * Ask permission for ONE call. Returns false when the call must be skipped. A caller
     * that got `true` MUST report back with success(), failure() or release().
     */
    tryAcquire() {
      if (state === "closed") return true;
      if (state === "open") {
        if (now() < openUntil) return false;
        state = "half-open"; // cool-down over: the next caller is the probe
        probing = true;
        return true;
      }
      if (probing) return false; // half-open and the probe is still in flight
      probing = true;
      return true;
    },
    success() {
      state = "closed";
      failures = 0;
      probing = false;
    },
    failure() {
      probing = false;
      if (state === "half-open") {
        state = "open";
        openUntil = now() + cooldownMs;
        return;
      }
      failures++;
      if (failures >= threshold) {
        state = "open";
        openUntil = now() + cooldownMs;
      }
    },
    /** The call ended in a way that says nothing about provider health (our own bad
     *  request): give the probe slot back without counting it either way. */
    release() {
      probing = false;
    },
    retryInMs: () => (state === "open" ? Math.max(0, openUntil - now()) : 0),
    snapshot: () => ({ state, failures, retryInMs: state === "open" ? Math.max(0, openUntil - now()) : 0 }),
  };
}

/** Reject after `ms`. The underlying work is NOT cancelled — a JS promise cannot be —
 *  so a timed-out provider call finishes in the background and still spends its quota. */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CallTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Does this error say the PROVIDER is unhealthy? A timeout, a network error, a 5xx, a
 * 429, an auth failure all do. A 400/422 is OUR malformed request: retrying it would fail
 * the same way on a healthy provider, so it must neither open nor reset the circuit.
 */
export function countsAsProviderFailure(err) {
  const status = err?.status ?? err?.code;
  return !(status === 400 || status === 422);
}

/**
 * Run `fn` under the breaker and a timeout.
 *   - circuit open        → throws CircuitOpenError immediately, `fn` is never called
 *   - success             → closes the circuit
 *   - timeout / provider  → counts toward opening it
 *   - our own bad request → neither
 *
 * @template T
 * @param {ReturnType<typeof createCircuitBreaker>} breaker
 * @param {() => Promise<T>} fn
 * @param {{timeoutMs: number}} options
 * @returns {Promise<T>}
 */
export async function runGuarded(breaker, fn, { timeoutMs }) {
  if (!breaker.tryAcquire()) throw new CircuitOpenError(breaker.retryInMs());
  try {
    const result = await withTimeout(Promise.resolve().then(fn), timeoutMs);
    breaker.success();
    return result;
  } catch (err) {
    if (countsAsProviderFailure(err)) breaker.failure();
    else breaker.release();
    throw err;
  }
}
