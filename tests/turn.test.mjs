import "./helpers/no-db.mjs";
import test, { describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  retrieveForTurn,
  rewriteQuery,
  SPECULATIVE_RAW_SEARCH,
  SPECULATIVE_REWRITE_BUDGET_MS,
} from "@/lib/agent/query";
import { CircuitOpenError, CallTimeoutError } from "@/lib/agent/breaker";

// retrieveForTurn gets stubbed `retrieve` and `rewrite` through `deps`; time is a fake clock
// (mock.timers patches setTimeout AND Date), so every latency below is an exact number.

afterEach(() => mock.timers.reset());
const start = () => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000_000 });
const flush = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A retrieve stub that takes `ms` and records every query it was asked. */
const makeRetrieve = ({ ms = 400, empty = () => false, reject = () => false } = {}) => {
  const calls = [];
  const fn = async ({ query, keywordQuery }) => {
    calls.push({ query, at: Date.now(), keywordQuery });
    await sleep(ms);
    if (reject(query)) throw new Error(`retrieval of "${query}" failed`);
    return empty(query) ? [] : [{ id: `chunk-for:${query}` }];
  };
  fn.calls = calls;
  return fn;
};
/** A rewrite stub: after `ms`, returns what `result(message)` says. */
const makeRewrite = ({ ms = 1_000, result }) => {
  const calls = [];
  const fn = async ({ message, timeoutMs }) => {
    calls.push({ message, timeoutMs, at: Date.now() });
    if (ms) await sleep(ms); // 0 = answers immediately (an open breaker), no timer to wait for
    return { ms, ...result(message) };
  };
  fn.calls = calls;
  return fn;
};
const rewritten = (query) => () => ({ query, status: "rewritten" });
const unchanged = () => (m) => ({ query: m, status: "unchanged" });
const failed = () => (m) => ({ query: m, status: "failed", error: "boom" });
const skipped = () => (m) => ({ query: m, status: "skipped" });

const HISTORY = [
  { role: "user", content: "How much is the Starter plan?" },
  { role: "assistant", content: "89 euros a month." },
];
const run = (args) => {
  const t0 = Date.now();
  let value;
  let at = null;
  const p = retrieveForTurn({ tenantId: "t", history: HISTORY, topK: 5, ...args }).then((v) => {
    value = v;
    at = Date.now() - t0;
  });
  return {
    get at() { return at; },
    get value() { return value; },
    done: p,
    /** advance the fake clock in 1ms steps, letting promises settle, until it resolves */
    async elapse(max = 10_000) {
      await flush(); // promise chains that start timers at t=0 must run before the clock moves
      for (let i = 0; i < max && at === null; i++) {
        mock.timers.tick(1);
        await flush(); // let every promise settle BEFORE the next millisecond, or `at` over-counts
      }
      await p;
      return at;
    },
  };
};

describe("defaults", () => {
  test("speculation ships OFF, with a budget shorter than the sequential 3s", () => {
    assert.equal(SPECULATIVE_RAW_SEARCH, false);
    assert.ok(SPECULATIVE_REWRITE_BUDGET_MS < 3_000);
  });
});

describe("rewriteQuery — fail soft and report why", () => {
  test("rewritten / unchanged / unusable output", async () => {
    const out = async (text) => rewriteQuery({ history: HISTORY, message: "and Growth?", generate: async () => text });
    assert.deepEqual({ ...(await out("What does the Growth plan cost?")), ms: 0 }, { query: "What does the Growth plan cost?", status: "rewritten", ms: 0 });
    assert.equal((await out("and growth?")).status, "unchanged");
    assert.equal((await out('"Growth plan price"\nBecause…')).query, "Growth plan price", "one line, quotes stripped");
    const bad = await out("x".repeat(400));
    assert.equal(bad.status, "failed");
    assert.equal(bad.query, "and Growth?", "the raw message is searched");
  });

  test("a provider error and a timeout are 'failed' (warned); an open circuit is 'skipped' (silent)", async () => {
    const warn = console.warn;
    const warnings = [];
    console.warn = (m) => warnings.push(m);
    try {
      const attempt = (err) => rewriteQuery({ history: HISTORY, message: "and Growth?", generate: async () => { throw err; } });
      const a = await attempt(Object.assign(new Error("503"), { status: 503 }));
      const b = await attempt(new CallTimeoutError(3000));
      assert.equal(a.status, "failed");
      assert.equal(b.status, "failed");
      assert.equal(warnings.length, 2);
      const c = await attempt(new CircuitOpenError(42_000));
      assert.equal(c.status, "skipped");
      assert.equal(c.query, "and Growth?");
      assert.match(c.error, /circuit open/);
      assert.equal(warnings.length, 2, "skipping logs nothing — it would be one line per turn");
    } finally {
      console.warn = warn;
    }
  });

  test("the budget is handed to the llm.js call, defaulting to 3000ms", async () => {
    const seen = [];
    const generate = async ({ timeoutMs }) => (seen.push(timeoutMs), "q");
    await rewriteQuery({ history: HISTORY, message: "and Growth?", generate });
    await rewriteQuery({ history: HISTORY, message: "and Growth?", generate, timeoutMs: 1234 });
    assert.deepEqual(seen, [3000, 1234]);
  });
});

describe("sequential (the shipped behaviour)", () => {
  test("a triggered follow-up costs rewrite + search: 1000ms + 400ms", async () => {
    start();
    const retrieve = makeRetrieve({ ms: 400 });
    const rewrite = makeRewrite({ ms: 1_000, result: rewritten("Growth plan price") });
    const r = run({ message: "And the Growth one?", deps: { retrieve, rewrite } });
    assert.equal(await r.elapse(), 1_400);
    assert.deepEqual(retrieve.calls.map((c) => c.query), ["Growth plan price"], "ONE search, of the rewritten query");
    assert.equal(r.value.trigger, "heuristic");
    assert.equal(r.value.searchQuery, "Growth plan price");
    assert.equal(rewrite.calls[0].timeoutMs, undefined, "default budget (3s) applies");
  });

  test("a rewrite that comes back unchanged still pays the full 1000 + 400", async () => {
    start();
    const r = run({ message: "who won yesterday?", deps: { retrieve: makeRetrieve({ ms: 400 }), rewrite: makeRewrite({ ms: 1_000, result: unchanged() }) } });
    assert.equal(await r.elapse(), 1_400);
  });
});

describe("speculative raw search (flag ON)", () => {
  test("rewrite UNCHANGED: finishes at max(rewrite, raw) = 1000ms, not 1400, with ONE search", async () => {
    start();
    const retrieve = makeRetrieve({ ms: 400 });
    const r = run({ message: "who won yesterday?", speculative: true, deps: { retrieve, rewrite: makeRewrite({ ms: 1_000, result: unchanged() }) } });
    assert.equal(await r.elapse(), 1_000);
    assert.equal(retrieve.calls.length, 1, "no extra embedding spent");
    assert.equal(retrieve.calls[0].at - 5_000_000, 0, "the raw search started at t=0, alongside the rewrite");
    assert.deepEqual(r.value.speculative, { rawUsed: true });
    assert.equal(r.value.chunks[0].id, "chunk-for:who won yesterday?");
  });

  test("rewrite CHANGED the query: no time saved (1000 + 400) and ONE EXTRA search was spent", async () => {
    start();
    const retrieve = makeRetrieve({ ms: 400 });
    const r = run({ message: "And the Growth one?", speculative: true, deps: { retrieve, rewrite: makeRewrite({ ms: 1_000, result: rewritten("Growth plan price") }) } });
    assert.equal(await r.elapse(), 1_400, "the rewritten query still has to be searched after the rewrite");
    assert.deepEqual(retrieve.calls.map((c) => c.query), ["And the Growth one?", "Growth plan price"], "raw search discarded: the cost of speculating");
    assert.deepEqual(r.value.speculative, { rawUsed: false });
    assert.equal(r.value.chunks[0].id, "chunk-for:Growth plan price");
  });

  test("rewrite FAILED or SKIPPED (breaker open): the raw result is used, no second search", async () => {
    for (const result of [failed(), skipped()]) {
      start();
      const retrieve = makeRetrieve({ ms: 400 });
      const rewrite = makeRewrite({ ms: 0, result });
      const r = run({ message: "What about weekends?", speculative: true, deps: { retrieve, rewrite } });
      assert.equal(await r.elapse(), 400, "bounded by the raw search alone");
      assert.equal(retrieve.calls.length, 1);
      assert.equal(r.value.speculative.rawUsed, true);
      mock.timers.reset();
    }
  });

  test("a SKIPPED rewrite (breaker open) costs just the search with or without speculation — the BREAKER is what removes the wait", async () => {
    start();
    const r = run({ message: "What about weekends?", speculative: false, deps: { retrieve: makeRetrieve({ ms: 400 }), rewrite: makeRewrite({ ms: 0, result: skipped() }) } });
    assert.equal(await r.elapse(), 400);
  });

  test("the rewrite is given the SHORT speculative budget, not 3s; an explicit override still wins", async () => {
    start();
    const rewrite = makeRewrite({ ms: 0, result: unchanged() });
    await run({ message: "and Growth?", speculative: true, deps: { retrieve: makeRetrieve({ ms: 0 }), rewrite } }).elapse();
    mock.timers.reset();
    start();
    await run({ message: "and Growth?", speculative: true, rewriteTimeoutMs: 15_000, deps: { retrieve: makeRetrieve({ ms: 0 }), rewrite } }).elapse();
    assert.deepEqual(rewrite.calls.map((c) => c.timeoutMs), [SPECULATIVE_REWRITE_BUDGET_MS, 15_000]);
  });

  test("a rewrite that loses the race (fails at the budget) answers at the budget, not after 3s", async () => {
    start();
    const retrieve = makeRetrieve({ ms: 200 });
    // what llm.js does at the budget: throws CallTimeoutError -> rewriteQuery reports "failed"
    const rewrite = makeRewrite({ ms: SPECULATIVE_REWRITE_BUDGET_MS, result: failed() });
    const r = run({ message: "and Growth?", speculative: true, deps: { retrieve, rewrite } });
    assert.equal(await r.elapse(), SPECULATIVE_REWRITE_BUDGET_MS);
    assert.equal(retrieve.calls.length, 1);
  });

  test("raw search rejecting while the REWRITTEN query wins is not an unhandled rejection", async () => {
    start();
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const retrieve = makeRetrieve({ ms: 100, reject: (q) => q === "And the Growth one?" });
      const r = run({ message: "And the Growth one?", speculative: true, deps: { retrieve, rewrite: makeRewrite({ ms: 500, result: rewritten("Growth price") }) } });
      await r.elapse();
      await flush();
      await flush();
      assert.equal(r.value.chunks[0].id, "chunk-for:Growth price");
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("…but when the raw result IS the one used, its failure propagates like any retrieval failure", async () => {
    start();
    const retrieve = makeRetrieve({ ms: 100, reject: () => true });
    const r = run({ message: "who won yesterday?", speculative: true, deps: { retrieve, rewrite: makeRewrite({ ms: 200, result: unchanged() }) } });
    const settled = r.done.then(() => null, (e) => e);
    for (let i = 0; i < 300; i++) {
      mock.timers.tick(1);
      await flush();
    }
    assert.match((await settled).message, /retrieval of .* failed/);
  });

  test("speculation is only for the heuristic path: not for a first message, concat, raw, or an untriggered question", async () => {
    start();
    const cases = [
      { message: "and Growth?", history: [], strategy: "rewrite" },
      { message: "and Growth?", strategy: "concat" },
      { message: "and Growth?", strategy: "raw" },
      { message: "How much is the Growth plan per month for a clinic?", strategy: "rewrite" },
    ];
    for (const c of cases) {
      const retrieve = makeRetrieve({ ms: 0 });
      const rewrite = makeRewrite({ ms: 0, result: unchanged() });
      const r = run({ ...c, speculative: true, deps: { retrieve, rewrite } });
      await r.elapse();
      assert.equal(r.value.speculative, undefined, JSON.stringify(c));
    }
  });
});

describe("the rest of the flow is unchanged", () => {
  test("the empty-first-pass net: an untriggered question that retrieves nothing is rewritten and searched again", async () => {
    start();
    const retrieve = makeRetrieve({ ms: 10, empty: (q) => q === "Please explain the second thing about pricing options" });
    const rewrite = makeRewrite({ ms: 10, result: rewritten("Growth plan price") });
    const r = run({ message: "Please explain the second thing about pricing options", deps: { retrieve, rewrite } });
    await r.elapse();
    assert.equal(r.value.trigger, "empty");
    assert.deepEqual(retrieve.calls.map((c) => c.query), ["Please explain the second thing about pricing options", "Growth plan price"]);
  });

  test("a pleasantry that retrieves nothing never pays for a rewrite", async () => {
    start();
    const rewrite = makeRewrite({ ms: 10, result: unchanged() });
    const r = run({ message: "thanks", deps: { retrieve: makeRetrieve({ ms: 1, empty: () => true }), rewrite } });
    await r.elapse();
    assert.equal(rewrite.calls.length, 0);
  });

  test("the keyword-query override reaches retrieval", async () => {
    start();
    const retrieve = makeRetrieve({ ms: 1 });
    const r = run({ message: "How much is the Growth plan per month for a clinic?", keywordQuery: "or", deps: { retrieve, rewrite: makeRewrite({ ms: 1, result: unchanged() }) } });
    await r.elapse();
    assert.equal(retrieve.calls[0].keywordQuery, "or");
  });
});
