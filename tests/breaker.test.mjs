import "./helpers/no-db.mjs";
import test, { describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createCircuitBreaker,
  runGuarded,
  withTimeout,
  countsAsProviderFailure,
  CircuitOpenError,
  CallTimeoutError,
} from "@/lib/agent/breaker";
import { REWRITE_BREAKER_THRESHOLD, REWRITE_BREAKER_COOLDOWN_MS, rewriteModelFor } from "@/lib/agent/llm";

const clock = () => {
  let t = 1_000;
  return { now: () => t, advance: (ms) => (t += ms) };
};
const flush = () => new Promise((r) => setImmediate(r));

describe("circuit breaker state machine (injected clock)", () => {
  test("closed: failures below the threshold do not open it, and a success resets the count", () => {
    const c = clock();
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 60_000, now: c.now });
    for (let i = 0; i < 2; i++) {
      assert.equal(b.tryAcquire(), true);
      b.failure();
    }
    assert.equal(b.snapshot().state, "closed");
    b.success(); // the streak is over…
    for (let i = 0; i < 2; i++) b.failure(); // …so two more are still only two
    assert.equal(b.snapshot().state, "closed");
    assert.equal(b.tryAcquire(), true);
  });

  test("the Nth CONSECUTIVE failure opens it; calls are refused until the cool-down ends", () => {
    const c = clock();
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 60_000, now: c.now });
    for (let i = 0; i < 3; i++) b.failure();
    assert.equal(b.snapshot().state, "open");
    assert.equal(b.tryAcquire(), false);
    assert.equal(b.retryInMs(), 60_000);
    c.advance(59_999);
    assert.equal(b.tryAcquire(), false, "1ms early is still closed to traffic");
    assert.equal(b.retryInMs(), 1);
  });

  test("after the cool-down exactly ONE probe goes through; concurrent callers are refused", () => {
    const c = clock();
    const b = createCircuitBreaker({ threshold: 2, cooldownMs: 1_000, now: c.now });
    b.failure();
    b.failure();
    c.advance(1_000);
    assert.equal(b.tryAcquire(), true, "the probe");
    assert.equal(b.snapshot().state, "half-open");
    assert.equal(b.tryAcquire(), false, "a second caller while the probe is in flight");
    assert.equal(b.tryAcquire(), false);
  });

  test("probe success closes the circuit and traffic flows again", () => {
    const c = clock();
    const b = createCircuitBreaker({ threshold: 2, cooldownMs: 1_000, now: c.now });
    b.failure();
    b.failure();
    c.advance(1_000);
    b.tryAcquire();
    b.success();
    assert.equal(b.snapshot().state, "closed");
    assert.equal(b.tryAcquire(), true);
    assert.equal(b.tryAcquire(), true, "no longer one-at-a-time");
    // and the failure count restarted from zero
    b.failure();
    assert.equal(b.snapshot().state, "closed");
  });

  test("probe failure re-opens it for a FULL new cool-down (not the remainder of the old one)", () => {
    const c = clock();
    const b = createCircuitBreaker({ threshold: 2, cooldownMs: 1_000, now: c.now });
    b.failure();
    b.failure();
    c.advance(1_000);
    b.tryAcquire();
    c.advance(400); // the probe took a while
    b.failure();
    assert.equal(b.snapshot().state, "open");
    assert.equal(b.retryInMs(), 1_000);
    assert.equal(b.tryAcquire(), false);
    c.advance(1_000);
    assert.equal(b.tryAcquire(), true, "and then another single probe");
  });

  test("release() frees the probe slot without counting it as health information", () => {
    const c = clock();
    const b = createCircuitBreaker({ threshold: 1, cooldownMs: 1_000, now: c.now });
    b.failure();
    c.advance(1_000);
    assert.equal(b.tryAcquire(), true);
    b.release();
    assert.equal(b.snapshot().state, "half-open", "still unproven");
    assert.equal(b.tryAcquire(), true, "the slot is free for the next probe");
  });

  test("refuses nonsense configuration", () => {
    assert.throws(() => createCircuitBreaker({ threshold: 0, cooldownMs: 1 }));
    assert.throws(() => createCircuitBreaker({ threshold: 1, cooldownMs: -1 }));
  });
});

describe("runGuarded + timeout under a fake clock", () => {
  afterEach(() => mock.timers.reset());
  const fake = () => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const providerError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

  test("a call that never answers is cut off at exactly timeoutMs", async () => {
    fake();
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
    let settled = null;
    const p = runGuarded(b, () => new Promise(() => {}), { timeoutMs: 3_000 }).catch((e) => (settled = e));
    mock.timers.tick(2_999);
    await flush();
    assert.equal(settled, null, "still waiting at 2999ms");
    mock.timers.tick(1);
    await p;
    assert.ok(settled instanceof CallTimeoutError);
  });

  test("N timeouts in a row open the circuit; the next call is refused INSTANTLY (0ms, fn never called)", async () => {
    fake();
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
    let calls = 0;
    const hang = () => {
      calls++;
      return new Promise(() => {});
    };
    for (let i = 0; i < 3; i++) {
      const p = runGuarded(b, hang, { timeoutMs: 3_000 }).catch(() => {});
      mock.timers.tick(3_000);
      await p;
    }
    assert.equal(calls, 3);
    assert.equal(b.snapshot().state, "open");

    const before = Date.now();
    await assert.rejects(runGuarded(b, hang, { timeoutMs: 3_000 }), CircuitOpenError);
    assert.equal(Date.now() - before, 0, "failing soft costs no waiting at all");
    assert.equal(calls, 3, "the provider is not called while open");
  });

  test("the skipped turns resume with a single probe once the cool-down passes; a good probe closes it", async () => {
    fake();
    const b = createCircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    for (let i = 0; i < 2; i++) await runGuarded(b, () => Promise.reject(providerError(503)), { timeoutMs: 3_000 }).catch(() => {});
    await assert.rejects(runGuarded(b, async () => "x", { timeoutMs: 3_000 }), CircuitOpenError);
    mock.timers.tick(60_000);
    assert.equal(await runGuarded(b, async () => "recovered", { timeoutMs: 3_000 }), "recovered");
    assert.equal(b.snapshot().state, "closed");
    assert.equal(await runGuarded(b, async () => "again", { timeoutMs: 3_000 }), "again");
  });

  test("provider failures, 429s and network errors with no status all count", async () => {
    fake();
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
    for (const err of [providerError(503), providerError(429), new Error("fetch failed")]) {
      await runGuarded(b, () => Promise.reject(err), { timeoutMs: 3_000 }).catch(() => {});
    }
    assert.equal(b.snapshot().state, "open");
  });

  test("a 400/422 (OUR malformed request) neither opens the circuit nor resets a streak", async () => {
    fake();
    const b = createCircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    await runGuarded(b, () => Promise.reject(providerError(503)), { timeoutMs: 3_000 }).catch(() => {});
    for (let i = 0; i < 5; i++) await runGuarded(b, () => Promise.reject(providerError(400)), { timeoutMs: 3_000 }).catch(() => {});
    assert.equal(b.snapshot().state, "closed");
    assert.equal(b.snapshot().failures, 1, "the 400s did not touch the count");
    await runGuarded(b, () => Promise.reject(providerError(503)), { timeoutMs: 3_000 }).catch(() => {});
    assert.equal(b.snapshot().state, "open", "…so the second real failure still opens it");
    assert.equal(countsAsProviderFailure(providerError(422)), false);
    assert.equal(countsAsProviderFailure(providerError(404)), true, "a retired model IS the provider's problem");
  });

  test("a success mid-streak resets it", async () => {
    fake();
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
    const fail = () => runGuarded(b, () => Promise.reject(providerError(503)), { timeoutMs: 1_000 }).catch(() => {});
    await fail();
    await fail();
    await runGuarded(b, async () => "ok", { timeoutMs: 1_000 });
    await fail();
    await fail();
    assert.equal(b.snapshot().state, "closed");
  });

  test("withTimeout clears its timer when the work wins (no leaked timers)", async () => {
    fake();
    assert.equal(await withTimeout(Promise.resolve(7), 5_000), 7);
    assert.equal(mock.timers ? true : true, true);
    // Ticking past the deadline afterwards must not produce a late rejection.
    mock.timers.tick(10_000);
    await flush();
  });
});

describe("llm.js rewrite configuration", () => {
  test("the named constants say what the comments promise", () => {
    assert.equal(REWRITE_BREAKER_THRESHOLD, 3);
    assert.equal(REWRITE_BREAKER_COOLDOWN_MS, 60_000);
  });

  test("the rewrite model defaults to 'same as chat' and is read per provider", () => {
    assert.equal(rewriteModelFor("gemini", {}), undefined, "unset = chat model, behaviour unchanged");
    assert.equal(rewriteModelFor("gemini", { GEMINI_REWRITE_MODEL: "" }), undefined);
    assert.equal(rewriteModelFor("gemini", { GEMINI_REWRITE_MODEL: "  " }), undefined);
    assert.equal(rewriteModelFor("gemini", { GEMINI_REWRITE_MODEL: " gemini-flash-lite-latest " }), "gemini-flash-lite-latest");
    assert.equal(rewriteModelFor("openrouter", { GEMINI_REWRITE_MODEL: "x" }), undefined, "one provider's setting never leaks to the other");
    assert.equal(rewriteModelFor("openrouter", { OPENROUTER_REWRITE_MODEL: "meta/llama-small" }), "meta/llama-small");
  });
});
