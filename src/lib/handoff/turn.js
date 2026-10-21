import { classifyTurn, INTENTS } from "@/lib/voice/intent";
import { enabledRecordTypes } from "@/lib/collect/config";
import { handoffAvailable } from "./config";
import { decideHandoff, readHandoffState, summariseForPerson } from "./decide";

/**
 * ONE TURN'S HANDOFF, from what respond() already knows — the glue between the pure decision
 * (decide.js) and the brain. No I/O: respond() persists the state and emits the event.
 *
 * Returns three things for three readers:
 *   - `plan`   — what the PROMPT needs (the kind, the reason, who — never a phone number);
 *   - `result` — what the ADAPTER needs (voice/session.js places the transfer from it: the full
 *                contact list in order, and a short summary for the person who picks up);
 *   - `state`  — what to persist.
 *
 * Tests: tests/handoff.test.mjs.
 */

/**
 * @param {object} args
 * @param {object} args.config            the tenant's agent config (config.escalation is normalised)
 * @param {unknown} args.storedState      conversations.handoff_state
 * @param {string} args.message
 * @param {Array<{role: string, content: string}>} args.earlierTurns
 * @param {string[]} args.sources         document titles retrieval handed the model this turn
 * @param {{state?: string, collected?: Array, lines?: Array}|null} args.collection  this turn's request plan
 * @param {number} args.nowMs
 */
export function planHandoff({ config, storedState, message, earlierTurns = [], sources = [], collection = null, nowMs }) {
  const handoffConfig = config.escalation;
  const before = readHandoffState(storedState);
  if (!handoffAvailable(handoffConfig)) return { changed: false, state: before, plan: null, result: null };

  const intent = classifyTurn({ callerText: message, sources, requestState: collection?.state ?? null }).intent;
  const callerMessages = earlierTurns.filter((m) => m.role === "user").map((m) => m.content);
  const { state, action } = decideHandoff({
    config: handoffConfig,
    agent: config,
    state: before,
    message,
    previousMessage: callerMessages.at(-1) ?? null,
    turn: {
      question: intent === INTENTS.QUESTION || intent === INTENTS.FOLLOWUP,
      hasSources: sources.length > 0,
      collecting: Boolean(collection?.state && collection.state !== "idle"),
    },
    nowMs,
    callbackAvailable: enabledRecordTypes(config.collect).includes("callback"),
  });

  const changed = JSON.stringify(state) !== JSON.stringify(before);
  if (!action) return { changed, state, plan: null, result: null };

  const contact = action.contacts?.[0] ?? null;
  const plan = { kind: action.kind, reason: action.reason ?? null, callback: action.callback ?? false, contact: contact ? { role: contact.role, name: contact.name } : null };
  const result =
    action.kind === "handoff"
      ? {
          kind: "handoff",
          reason: action.reason,
          contacts: action.contacts,
          summary: summariseForPerson({
            reason: action.reason,
            callerMessages: [...callerMessages.slice(-2), message],
            details: (collection?.collected ?? collection?.lines ?? []).map((l) => ({ label: l.label, display: l.display })),
          }),
        }
      : { kind: action.kind, reason: action.reason ?? null, callback: action.callback ?? false };
  return { changed, state, plan, result };
}
