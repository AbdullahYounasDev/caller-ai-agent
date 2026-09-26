import { prisma } from "@/lib/db";

/**
 * BACKGROUND INGEST QUEUE.
 *
 * Importing a document is not a request-response operation. A 40-page PDF is
 * thirty-odd embedding calls; a scanned one adds OCR on top, which is seconds
 * per page. Done inline that is an HTTP request held open for minutes, a
 * business watching a spinner with no idea whether anything is happening, and a
 * proxy timeout that kills the upload halfway with no way to tell.
 *
 * So an upload returns a JOB id immediately and the work continues behind it.
 *
 * ── WHY PROGRESS LIVES IN THE DATABASE ───────────────────────────────────
 * The queue itself is in memory, but every progress update is written to
 * `ingest_jobs`. That costs a row update every few seconds and buys two things
 * worth far more: a business can reload the page mid-import and still see where
 * it got to, and a job abandoned by a process restart is visible as a stuck row
 * rather than vanishing silently.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ SINGLE PROCESS. This queue is an array in one Node process. Run two
 * instances and each gets its own queue — which is fine, since each job is
 * self-contained and claimed by whichever process received the upload — but a
 * process restart abandons whatever it was running. `reapStaleJobs()` below is
 * what stops those becoming permanent spinners. Before scaling out properly,
 * move this to a real queue (BullMQ on Redis); the call sites are narrow enough
 * that only this file changes.
 */

/**
 * CONCURRENCY IS 1, DELIBERATELY.
 *
 * The work is dominated by embedding calls against a per-tenant model quota.
 * Running jobs in parallel does not make them finish sooner — it makes them
 * contend for the same rate limit and fail together. Sequential also means a
 * ten-file upload has a predictable order, so the progress a business sees
 * matches the order they picked the files in.
 */
const CONCURRENCY = 1;

/** A job whose row has not been touched in this long was abandoned by a crashed
 *  process. Generous, because OCR of a big page can legitimately be slow. */
const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Stage weights. Progress is derived from these rather than set ad hoc, so the
 * bar only ever moves forward — a bar that jumps backwards reads as a bug even
 * when the work is fine.
 *
 * Embedding dominates because it genuinely does: one network round trip per
 * chunk. OCR, when it happens, is slower still and gets its own span.
 */
const STAGES = {
  queued: { start: 0, end: 2 },
  extracting: { start: 2, end: 12 },
  ocr: { start: 12, end: 55 },
  chunking: { start: 55, end: 60 },
  embedding: { start: 60, end: 98 },
  saving: { start: 98, end: 100 },
};

/** @type {Array<{id: string, run: (ctx: JobContext) => Promise<void>}>} */
const queue = [];
let draining = false;

/**
 * Jobs the user has asked to stop, keyed by job id. In-memory, like the queue
 * itself — a job's own `run()` is a plain async function with no way to reach
 * in and stop it, so cancellation is cooperative: every progress checkpoint it
 * already calls (`ctx.report`, once per page/chunk) also doubles as a place to
 * notice the request and unwind, rather than needing a second signalling path
 * threaded through crawl/OCR/embedding separately.
 */
const cancelledJobIds = new Set();

/** Thrown from `JobContext.report()` when its job has been cancelled, and left
 *  to propagate out of whatever loop was mid-page or mid-chunk. Callers that
 *  need to clean up partial work (lib/agent/ingest.js) check for this specific
 *  class rather than treating cancellation as an ordinary failure. */
export class JobCancelledError extends Error {
  constructor(jobId) {
    super(`Job ${jobId} was cancelled`);
    this.name = "JobCancelledError";
  }
}

/**
 * Handed to each job so it can report progress without knowing anything about
 * how progress is stored or scaled.
 */
class JobContext {
  constructor(jobId) {
    this.jobId = jobId;
  }

  isCancelled() {
    return cancelledJobIds.has(this.jobId);
  }

  /**
   * @param {keyof STAGES} stage
   * @param {number} [done] units finished within this stage
   * @param {number} [total] units in this stage
   */
  async report(stage, done = 0, total = 0) {
    // Checked BEFORE writing progress: cancelJob() has already set this job's
    // row to "cancelled", and a progress write racing in after that would
    // silently flip it back to "processing".
    if (this.isCancelled()) throw new JobCancelledError(this.jobId);

    const span = STAGES[stage] ?? STAGES.queued;
    const fraction = total > 0 ? Math.min(1, done / total) : 0;
    const progress = Math.round(span.start + (span.end - span.start) * fraction);

    await prisma.ingestJob
      .update({
        where: { id: this.jobId },
        data: { stage, progress, itemsDone: done, itemsTotal: total },
      })
      .catch(() => {
        // Progress reporting must never break the work it is reporting on.
      });
  }

  /** The source row, once the job has created it. Lets the UI link a running
   *  job to the document it is producing. */
  async attachSource(sourceId) {
    await prisma.ingestJob
      .update({ where: { id: this.jobId }, data: { sourceId } })
      .catch(() => {});
  }
}

/**
 * Create a job row and queue the work.
 *
 * Returns as soon as the row exists — the caller (an HTTP handler) answers the
 * browser immediately and the work carries on here.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.title
 * @param {"text"|"file"|"url"} args.kind
 * @param {string} [args.fileName]
 * @param {number} [args.byteSize]
 * @param {(ctx: JobContext) => Promise<{sourceId: string, chunkCount: number}>} args.run
 * @returns {Promise<object>} the job row
 */
export async function enqueueJob({ tenantId, title, kind, fileName, byteSize, run }) {
  const job = await prisma.ingestJob.create({
    data: {
      tenantId,
      title,
      kind,
      fileName: fileName ?? null,
      byteSize: byteSize ?? null,
      status: "queued",
      stage: "queued",
      progress: 0,
    },
  });

  queue.push({ id: job.id, run });
  // Not awaited: the whole point is that the caller returns now.
  void drain();

  return job;
}

async function drain() {
  if (draining) return;
  draining = true;

  try {
    while (queue.length) {
      const item = queue.shift();
      const ctx = new JobContext(item.id);

      try {
        await prisma.ingestJob.update({
          where: { id: item.id },
          data: { status: "processing", startedAt: new Date(), stage: "extracting", progress: 2 },
        });
        // Narrow race: a cancel() request could have landed between the queue
        // shift above and this update committing, which would otherwise flip
        // a "cancelled" row straight back to "processing". Checked once more
        // right before doing any real work.
        if (ctx.isCancelled()) throw new JobCancelledError(item.id);

        const result = await item.run(ctx);

        await prisma.ingestJob.update({
          where: { id: item.id },
          data: {
            status: "done",
            stage: "saving",
            progress: 100,
            sourceId: result?.sourceId ?? undefined,
            itemsDone: result?.chunkCount ?? 0,
            itemsTotal: result?.chunkCount ?? 0,
            finishedAt: new Date(),
            error: null,
          },
        });
      } catch (err) {
        if (err instanceof JobCancelledError) {
          // cancelJob() already set this job's row to "cancelled" and
          // lib/agent/ingest.js has already rolled back or removed whatever
          // partial row, chunks or Cloudinary upload this attempt produced —
          // there is nothing left to record here.
          cancelledJobIds.delete(item.id);
          continue;
        }

        console.error(`[jobs] ${item.id} failed:`, err);
        // The failure is recorded ON the job. A business needs to see which
        // file failed and why, not a toast that vanished while they were away.
        await prisma.ingestJob
          .update({
            where: { id: item.id },
            data: {
              status: "failed",
              error: String(err?.message ?? err).slice(0, 500),
              finishedAt: new Date(),
            },
          })
          .catch(() => {});
      }
    }
  } finally {
    draining = false;
    // A job enqueued while the loop was finishing would otherwise sit forever.
    if (queue.length) void drain();
  }
}

/**
 * Cancel a job the user no longer wants to wait for.
 *
 * A QUEUED job is simply removed from the in-memory queue before it ever
 * starts — nothing has been written anywhere yet, so there is nothing to clean
 * up beyond the row itself.
 *
 * A PROCESSING job can't be stopped mid-`await` — `run()` is a plain async
 * function, not a cancellable operation — so this only records the request.
 * The job's own next progress checkpoint (JobContext.report above, called
 * once per page fetched, OCR'd or chunk embedded) notices and throws
 * JobCancelledError, unwinding out of crawlSite/ocrPdf/ingestDocument.
 * ingestDocument is what owns any partial row, chunks or Cloudinary upload by
 * that point, so cleaning those up is its job, not this function's — see its
 * own JobCancelledError handling.
 *
 * @param {string} tenantId
 * @param {string} jobId
 * @returns {Promise<object|null>} the updated job row, or null if it doesn't
 *   belong to this tenant or doesn't exist.
 */
export async function cancelJob(tenantId, jobId) {
  const job = await prisma.ingestJob.findUnique({ where: { id: jobId } });
  if (!job || job.tenantId !== tenantId) return null;
  if (["done", "failed", "cancelled"].includes(job.status)) return job;

  cancelledJobIds.add(jobId);

  const idx = queue.findIndex((q) => q.id === jobId);
  if (idx !== -1) {
    // Still queued — it will never run, so nothing will ever throw
    // JobCancelledError for it and clear this entry. Do it here instead.
    queue.splice(idx, 1);
    cancelledJobIds.delete(jobId);
  }

  return prisma.ingestJob.update({
    where: { id: jobId },
    data: { status: "cancelled", error: "Cancelled by user", finishedAt: new Date() },
  });
}

/**
 * Mark abandoned jobs as failed.
 *
 * A job left "processing" by a crashed or restarted process has nothing driving
 * it, and would otherwise show a progress bar that never moves — the most
 * confusing possible state, because it looks like it is still working.
 *
 * "queued" is NOT treated the same way, and that distinction matters.
 * CONCURRENCY IS 1, deliberately (see above) — a job can legitimately sit
 * queued for a long time behind a slow OCR job ahead of it, with no progress
 * update of its own the whole time, because it hasn't started yet. Reaping it
 * on the same timeout as "processing" used to mark it "failed" purely for
 * waiting its turn — and then drain() would run it anyway once its turn came,
 * flipping the status right back, which read as the job randomly un-failing.
 *
 * The actual question for a queued row is narrower: is the PROCESS that owns
 * this in-memory queue still alive and still planning to run it? That's
 * answered by checking the in-memory `queue` array itself — if this job's id
 * is still in it, the process is alive and it is genuinely just waiting; if
 * it isn't (a restart wipes `queue` back to empty), the row is an orphan from
 * before the restart and nothing will ever pick it up.
 *
 * Called from the jobs endpoint rather than on a timer: it only matters when
 * someone is looking, and a timer in a serverless-ish runtime is unreliable.
 */
export async function reapStaleJobs(tenantId) {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const failure = {
    status: "failed",
    error: "Interrupted — the server restarted while this was importing. Try again.",
    finishedAt: new Date(),
  };

  const processingReap = prisma.ingestJob.updateMany({
    where: { tenantId, status: "processing", updatedAt: { lt: cutoff } },
    data: failure,
  });

  const queuedIds = new Set(queue.map((item) => item.id));
  const staleQueued = await prisma.ingestJob.findMany({
    where: { tenantId, status: "queued", updatedAt: { lt: cutoff } },
    select: { id: true },
  });
  const orphanedIds = staleQueued.map((j) => j.id).filter((id) => !queuedIds.has(id));

  const [{ count: processingCount }] = await Promise.all([
    processingReap,
    orphanedIds.length
      ? prisma.ingestJob.updateMany({ where: { id: { in: orphanedIds } }, data: failure })
      : Promise.resolve({ count: 0 }),
  ]);

  return processingCount + orphanedIds.length;
}

/**
 * Jobs worth showing: everything unfinished, plus recently finished ones so a
 * success or failure stays on screen long enough to be read.
 */
export async function listJobs(tenantId, { since = 2 * 60 * 1000 } = {}) {
  await reapStaleJobs(tenantId);

  return prisma.ingestJob.findMany({
    where: {
      tenantId,
      OR: [
        { status: { in: ["queued", "processing"] } },
        { finishedAt: { gt: new Date(Date.now() - since) } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      stage: true,
      progress: true,
      itemsDone: true,
      itemsTotal: true,
      fileName: true,
      error: true,
      sourceId: true,
      createdAt: true,
    },
  });
}

/** Clear finished jobs a business has already seen. */
export async function dismissFinishedJobs(tenantId) {
  const { count } = await prisma.ingestJob.deleteMany({
    where: { tenantId, status: { in: ["done", "failed", "cancelled"] } },
  });
  return count;
}

export const JOB_CONCURRENCY = CONCURRENCY;
