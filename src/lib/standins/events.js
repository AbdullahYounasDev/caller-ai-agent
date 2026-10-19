import { randomUUID } from "node:crypto";

/**
 * STAND-IN for the engine → backend event delivery (see ./README.md).
 *
 * The real thing is a signed HTTP POST per event, retried until acknowledged, written to a
 * database outbox so the voice gateway (a separate process) can enqueue too. Here it is an
 * in-process list of listeners, which is enough to build against: every place that WOULD
 * tell the backend something calls `emitEngineEvent`, with the envelope the contract
 * defines ({ id, type, tenantId, occurredAt, data } — backend-events.openapi.yaml), so wiring
 * the real sender in later changes this file and nothing else.
 *
 * Event data carries IDS and reference numbers, never the customer's details: the backend
 * reads those from the record (docs/handoff-to-backend.md explains the open question).
 */

const listeners = new Set();

/** @param {(event: object) => void} listener @returns {() => void} unsubscribe */
export function onEngineEvent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * @param {{type: string, tenantId: string, data: object}} event
 * @returns {object} the envelope
 */
export function emitEngineEvent({ type, tenantId, data }) {
  const envelope = { id: randomUUID(), type, tenantId, occurredAt: new Date().toISOString(), data };
  for (const listener of listeners) {
    try {
      listener(envelope);
    } catch (err) {
      // Telling someone about an event must never break the work it reports on.
      console.warn(`[events] a listener for ${type} threw: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  return envelope;
}
