import { prisma } from "@/lib/db";

/**
 * EVERYTHING A CALL WRITES TO THE DATABASE — one object per call, owned by the session.
 *
 *   conversations / messages   what was said — the SAME tables the chat uses, so a
 *                              voice call is a conversation like any other (§1).
 *                              The caller's and agent's turns are written by respond();
 *                              only the greeting is written here.
 *   call_logs                  one row: transport, engine, status, why it ended,
 *                              duration, turn count, interruptions, median latency
 *   call_turns                 one row per exchange: transcript, reply, intent,
 *                              outcome, sources, per-stage timings
 *   call_events                the timeline, append-only
 *
 * ── NOTHING HERE MAY SLOW A TURN DOWN ────────────────────────────────────
 * Every write except opening the call is fire-and-forget from the session's point of
 * view: it is tracked, and close() waits for all of them, but no turn ever awaits a log
 * write. Timeline events are buffered and flushed in batches (one INSERT per
 * EVENT_FLUSH_MS instead of one per event). A failed write is logged and dropped — a
 * lost log line must never become a dropped call. Same rule as job progress (§6.6).
 * ─────────────────────────────────────────────────────────────────────────
 */

const EVENT_FLUSH_MS = 400;

export class CallRecorder {
  /**
   * Answer the call: create its conversation and its call_logs row.
   *
   * @param {object} args
   * @param {string} args.tenantId
   * @param {string|null} [args.agentId]  the agent answering — stored on the conversation and the call
   * @param {"browser"|"twilio"} args.transport
   * @param {object} args.engine       which models serve it — stored on the row
   * @param {string} [args.fromNumber]
   * @param {string} [args.toNumber]
   * @param {object} [args.db]         Prisma client; injectable for tests
   */
  static async open({ tenantId, agentId = null, transport, engine, fromNumber = null, toNumber = null, db = prisma }) {
    const conversation = await db.conversation.create({ data: { tenantId, agentId, channel: "voice" } });
    const call = await db.callLog.create({
      data: { tenantId, agentId, conversationId: conversation.id, transport, engine, fromNumber, toNumber },
    });
    return new CallRecorder({ db, tenantId, callId: call.id, conversationId: conversation.id });
  }

  constructor({ db, tenantId, callId, conversationId }) {
    this.db = db;
    this.tenantId = tenantId;
    this.callId = callId;
    this.conversationId = conversationId;
    this.startedAt = performance.now();
    this.seq = 0;
    this.buffer = [];
    this.timer = null;
    this.pending = new Set();
    this.closed = false;
  }

  /** Milliseconds since the call was answered. */
  elapsed() {
    return Math.round(performance.now() - this.startedAt);
  }

  /**
   * Append a timeline event. Returns it immediately (for the live console view);
   * the database write happens in the next batch.
   *
   * @param {string} type
   * @param {object} [data]
   * @returns {{seq: number, type: string, atMs: number, data: object|null}}
   */
  event(type, data = null) {
    const event = { seq: ++this.seq, type, atMs: this.elapsed(), data };
    if (this.closed) return event;
    this.buffer.push(event);
    this.timer ??= setTimeout(() => this.flushEvents(), EVENT_FLUSH_MS);
    return event;
  }

  flushEvents() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0);
    this.track(
      this.db.callEvent.createMany({
        data: batch.map((e) => ({
          callId: this.callId,
          tenantId: this.tenantId,
          seq: e.seq,
          type: e.type,
          atMs: e.atMs,
          data: e.data ?? undefined,
        })),
      }),
      "events"
    );
  }

  /** A line the agent spoke that did not come from respond() — the greeting. Written to
   *  `messages` so the transcript of the call is complete. */
  agentLine(text) {
    this.track(
      this.db.message.create({
        data: { conversationId: this.conversationId, tenantId: this.tenantId, channel: "voice", role: "assistant", content: text },
      }),
      "greeting"
    );
  }

  /**
   * @param {object} turn  see the call_turns columns in prisma/schema.prisma
   */
  turn(turn) {
    this.track(
      this.db.callTurn.create({
        data: {
          callId: this.callId,
          tenantId: this.tenantId,
          index: turn.index,
          callerText: turn.callerText,
          agentText: turn.agentText,
          spokenText: turn.spokenText ?? null,
          interrupted: Boolean(turn.interrupted),
          language: turn.language ?? null,
          intent: turn.intent,
          outcome: turn.outcome,
          topic: turn.topic ?? null,
          sources: turn.sources ?? [],
          searchQuery: turn.searchQuery ?? null,
          rewriteStatus: turn.rewriteStatus ?? null,
          model: turn.model ?? null,
          responseMs: turn.responseMs ?? null,
          timings: turn.timings ?? {},
          error: turn.error ?? null,
        },
      }),
      "turn"
    );
  }

  /**
   * Hang up: flush the timeline, wait for every outstanding write, then write the
   * call's summary. Safe to call twice.
   *
   * @param {object} summary
   * @param {"completed"|"failed"} summary.status
   * @param {string} summary.reason      END_REASONS value
   * @param {number} summary.turnCount
   * @param {number} summary.interruptions
   * @param {number[]} summary.responseTimes  per-turn responseMs
   */
  async close({ status, reason, turnCount, interruptions, responseTimes }) {
    if (this.closed) return;
    this.flushEvents();
    this.closed = true;
    await Promise.allSettled([...this.pending]);

    await this.db.callLog
      .update({
        where: { id: this.callId },
        data: {
          status,
          endReason: reason,
          endedAt: new Date(),
          durationSec: Math.round(this.elapsed() / 1000),
          turnCount,
          interruptions,
          medianResponseMs: median(responseTimes),
        },
      })
      .catch((err) => console.error(`[voice] could not close call ${this.callId}:`, err?.message ?? err));
  }

  track(promise, what) {
    const p = Promise.resolve(promise)
      .catch((err) => console.error(`[voice] ${what} write failed for call ${this.callId}:`, err?.message ?? err))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
}

/** @param {number[]} values */
export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
