import test, { describe, before } from "node:test";
import assert from "node:assert/strict";

// ── An in-memory stand-in for the three prisma calls jobs.js makes ────────────────────
// db.js reuses globalThis.prisma when set, so planting the fake BEFORE importing jobs.js
// is the whole seam. Every method is async because jobs.js chains `.catch` on updates.
const rows = new Map();
let seq = 0;
const hooks = { findUnique: null }; // lets a test hold a read open to force a race

const matches = (row, where) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("lt" in v) return row[k] < v.lt;
      if ("gt" in v) return row[k] > v.gt;
    }
    return row[k] === v;
  });

globalThis.prisma = {
  ingestJob: {
    async create({ data }) {
      const row = { id: `job${++seq}`, createdAt: new Date(), updatedAt: new Date(), error: null, ...data };
      rows.set(row.id, row);
      return { ...row };
    },
    async update({ where, data }) {
      const row = rows.get(where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of rows.values()) {
        if (matches(row, where)) {
          Object.assign(row, data, { updatedAt: new Date() });
          count++;
        }
      }
      return { count };
    },
    async findUnique({ where }) {
      const snapshot = rows.get(where.id) ? { ...rows.get(where.id) } : null;
      if (hooks.findUnique) await hooks.findUnique();
      return snapshot;
    },
    async findMany({ where }) {
      return [...rows.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }));
    },
    async deleteMany() {
      return { count: 0 };
    },
  },
};

let jobs;
before(async () => {
  jobs = await import("@/lib/agent/jobs");
});

const TENANT = "t1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what) => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const gate = () => {
  let open;
  const promise = new Promise((r) => (open = r));
  return { promise, open };
};
const enqueue = (run, title = "doc") => jobs.enqueueJob({ tenantId: TENANT, title, kind: "text", run });
/** Concurrency is 1, so once a LATER job is done, every earlier one has fully settled. */
const drained = async () => {
  const marker = await enqueue(async () => ({ sourceId: "marker", chunkCount: 0 }), "marker");
  await until(() => rows.get(marker.id).status === "done", "queue to drain");
};

describe("cancelJob — the cancel/finish race (§6.14)", () => {
  test("a job already past its last checkpoint is reported DONE, not 'cancelled'", async () => {
    const g = gate();
    let started = false;
    const job = await enqueue(async () => {
      started = true;
      await g.promise; // never calls ctx.report() again: nothing left to throw JobCancelledError
      return { sourceId: "s1", chunkCount: 3 };
    });
    await until(() => started, "job to start");

    const pending = jobs.cancelJob(TENANT, job.id);
    await sleep(20); // cancelJob is now waiting on the settler…
    g.open(); // …and the job completes on its own
    const result = await pending;

    assert.equal(result.status, "done", "the DELETE must not lie about an import that fully succeeded");
    assert.equal(rows.get(job.id).status, "done");
    assert.equal(rows.get(job.id).itemsDone, 3);
  });

  test("a job cancelled BEFORE its next checkpoint unwinds and ends 'cancelled' (drain never overwrites it)", async () => {
    const g = gate();
    let started = false;
    let reachedEnd = false;
    const job = await enqueue(async (ctx) => {
      started = true;
      await g.promise;
      await ctx.report("embedding", 1, 3); // the checkpoint that notices the cancel
      reachedEnd = true;
      return { sourceId: "s2", chunkCount: 3 };
    });
    await until(() => started, "job to start");

    const result = await jobs.cancelJob(TENANT, job.id); // waits out its bounded 300ms, then writes
    assert.equal(result.status, "cancelled");
    assert.equal(result.error, "Cancelled by user");

    g.open();
    await drained();
    assert.equal(reachedEnd, false, "work after the checkpoint never ran");
    assert.equal(rows.get(job.id).status, "cancelled", "drain() must not flip it back to processing/done/failed");
  });

  test("RACE: the job finishes while cancelJob is still reading the row — the finished job is NOT overwritten with 'cancelled'", async () => {
    const g = gate();
    let started = false;
    const job = await enqueue(async () => {
      started = true;
      await g.promise;
      return { sourceId: "s3", chunkCount: 5 };
    });
    await until(() => started, "job to start");

    // Hold cancelJob's first read open: it will have seen "processing"…
    const readHeld = gate();
    hooks.findUnique = () => readHeld.promise;
    const pending = jobs.cancelJob(TENANT, job.id);
    await sleep(10);
    hooks.findUnique = null;

    // …then the job completes and drain() tears down its settler.
    g.open();
    await until(() => rows.get(job.id).status === "done", "job to finish");
    await sleep(20);
    readHeld.open();

    const result = await pending;
    assert.equal(result.status, "done", "cancelJob acted on a stale read");
    assert.equal(rows.get(job.id).status, "done", "a completed import must stay done");
    assert.equal(rows.get(job.id).error, null);
  });

  test("a QUEUED job is removed before it ever runs and marked cancelled at once", async () => {
    const g = gate();
    let started = false;
    let ranB = false;
    const blocker = await enqueue(async () => {
      started = true;
      await g.promise;
      return { sourceId: "a", chunkCount: 1 };
    }, "blocker");
    await until(() => started, "blocker to start");
    const queued = await enqueue(async () => {
      ranB = true;
      return { sourceId: "b", chunkCount: 1 };
    }, "queued");

    const result = await jobs.cancelJob(TENANT, queued.id);
    assert.equal(result.status, "cancelled");

    g.open();
    await until(() => rows.get(blocker.id).status === "done", "blocker to finish");
    await drained();
    assert.equal(ranB, false, "a cancelled queued job must never execute");
    assert.equal(rows.get(queued.id).status, "cancelled");
  });

  test("another tenant's job, an unknown id and an already-finished job", async () => {
    const job = await enqueue(async () => ({ sourceId: "x", chunkCount: 1 }));
    await until(() => rows.get(job.id).status === "done", "job to finish");

    assert.equal(await jobs.cancelJob("someone-else", job.id), null);
    assert.equal(await jobs.cancelJob(TENANT, "nope"), null);
    const again = await jobs.cancelJob(TENANT, job.id);
    assert.equal(again.status, "done", "finished jobs are returned untouched");
  });
});

describe("queue behaviour", () => {
  test("concurrency is 1: the second job starts only after the first has finished", async () => {
    const order = [];
    const g = gate();
    const first = await enqueue(async () => {
      order.push("first:start");
      await g.promise;
      order.push("first:end");
      return { sourceId: "1", chunkCount: 1 };
    });
    const second = await enqueue(async () => {
      order.push("second:start");
      return { sourceId: "2", chunkCount: 1 };
    });
    await until(() => order.includes("first:start"), "first to start");
    await sleep(30);
    assert.deepEqual(order, ["first:start"], "second must wait");
    assert.equal(rows.get(second.id).status, "queued");

    g.open();
    await until(() => rows.get(second.id).status === "done", "second to finish");
    assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
    assert.equal(rows.get(first.id).status, "done");
  });

  test("a failing job is recorded as failed with a truncated error and the next job still runs", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const bad = await enqueue(async () => {
        throw new Error("x".repeat(900));
      });
      await drained();
      assert.equal(rows.get(bad.id).status, "failed");
      assert.equal(rows.get(bad.id).error.length, 500);
      assert.ok(rows.get(bad.id).finishedAt instanceof Date);
    } finally {
      console.error = quiet;
    }
  });

  test("progress is the stage span scaled by done/total, and never writes after a cancel", async () => {
    const seen = [];
    const g = gate();
    let ctxRef;
    const job = await enqueue(async (ctx) => {
      ctxRef = ctx;
      await ctx.report("embedding", 0, 4);
      seen.push(rows.get(ctx.jobId).progress);
      await ctx.report("embedding", 2, 4);
      seen.push(rows.get(ctx.jobId).progress);
      await ctx.report("embedding", 99, 4); // over-reporting clamps to the end of the span
      seen.push(rows.get(ctx.jobId).progress);
      await g.promise;
      await ctx.report("embedding", 1, 4);
      return { sourceId: "p", chunkCount: 4 };
    });
    await until(() => seen.length === 3, "progress reports");
    assert.deepEqual(seen, [60, 79, 98]); // embedding spans 60..98

    const before = rows.get(job.id).progress;
    await jobs.cancelJob(TENANT, job.id);
    g.open();
    await drained();
    assert.equal(ctxRef.isCancelled(), false, "the flag is cleared once the job has unwound");
    assert.equal(rows.get(job.id).status, "cancelled");
    assert.equal(rows.get(job.id).progress, before, "a late report must not move a cancelled job");
  });
});

describe("reapStaleJobs — queued vs processing (§6.6)", () => {
  const OLD = () => new Date(Date.now() - 6 * 60 * 1000); // past the 5 minute cutoff
  const plant = (over) => {
    const row = { id: `planted${++seq}`, tenantId: TENANT, status: "processing", createdAt: new Date(), updatedAt: new Date(), error: null, ...over };
    rows.set(row.id, row);
    return row;
  };

  test("a stale PROCESSING row is reaped; a fresh one is not", async () => {
    const stale = plant({ status: "processing", updatedAt: OLD() });
    const fresh = plant({ status: "processing" });
    await jobs.reapStaleJobs(TENANT);
    assert.equal(rows.get(stale.id).status, "failed");
    assert.match(rows.get(stale.id).error, /Interrupted/);
    assert.equal(rows.get(fresh.id).status, "processing");
  });

  test("a stale QUEUED row still sitting in the live in-memory queue is NOT reaped — it is just waiting its turn", async () => {
    const g = gate();
    let started = false;
    const blocker = await enqueue(async () => {
      started = true;
      await g.promise;
      return { sourceId: "b", chunkCount: 1 };
    }, "blocker");
    await until(() => started, "blocker to start");
    const waiting = await enqueue(async () => ({ sourceId: "w", chunkCount: 1 }), "waiting");
    rows.get(waiting.id).updatedAt = OLD(); // it has been queued for a long time

    await jobs.reapStaleJobs(TENANT);
    assert.equal(rows.get(waiting.id).status, "queued", "reaping it used to flap failed → processing → done");

    g.open();
    await until(() => rows.get(waiting.id).status === "done", "waiting job to run");
    assert.equal(rows.get(blocker.id).status, "done");
  });

  test("a stale QUEUED row that is NOT in the queue is an orphan from before a restart and IS reaped", async () => {
    const orphan = plant({ status: "queued", updatedAt: OLD() });
    const freshQueued = plant({ status: "queued" });
    await jobs.reapStaleJobs(TENANT);
    assert.equal(rows.get(orphan.id).status, "failed");
    assert.equal(rows.get(freshQueued.id).status, "queued", "a recent queued row is left alone either way");
  });

  test("only the given tenant's rows are touched, and the count is returned", async () => {
    const mine = plant({ status: "processing", updatedAt: OLD() });
    const theirs = plant({ status: "processing", updatedAt: OLD(), tenantId: "other" });
    const orphan = plant({ status: "queued", updatedAt: OLD() });
    const reaped = await jobs.reapStaleJobs(TENANT);
    assert.equal(reaped, 2);
    assert.equal(rows.get(mine.id).status, "failed");
    assert.equal(rows.get(orphan.id).status, "failed");
    assert.equal(rows.get(theirs.id).status, "processing");
  });
});
