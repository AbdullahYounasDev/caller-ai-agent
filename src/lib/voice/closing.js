import { asksAnythingElse, isDecliningMore, lastSentence, saysFarewell } from "@/lib/phrases";

// INTENTS.GOODBYE of ./intent.js, not imported: intent.js pulls in the agent stack, which reaches
// tenant/config.js — and that file reads this one's defaults while it loads.
const GOODBYE_INTENT = "goodbye";

/**
 * ENDING A CALL BY ITSELF — when has the conversation come to its end? (CLAUDE.md §6.24)
 *
 * A finished call that stays open is dead air the caller has to end themselves; a call ended too
 * early cuts someone off. So the decision is rules (no model call), it is conservative, and the
 * owner can switch it off or give callers more time (`autoEndCalls`, `endCallDelaySeconds`, per
 * agent). After a "yes", voice/session.js waits until the agent's last words have PLAYED, then the
 * owner's delay; any speech from the caller in that time cancels it.
 *
 * It ends when, and only when, the agent's reply did not ask anything and:
 *   - the caller said goodbye ("bye", "that's all, thanks", "khuda hafiz") in a short message;
 *   - the agent had asked "anything else?" and the caller declined ("no thanks", "nahi", "بس");
 *   - the agent itself closed ("…Have a great day!", "خدا حافظ").
 * Never while a request is half-taken, never after "hold on", never when the turn failed or a
 * transfer is under way. When the caller closed but the reply did not say goodbye, the session
 * says a fixed closing line first ("Thank you for calling. Goodbye.") — a call never ends on
 * "You're welcome!" with no goodbye.
 *
 * The words are in lib/phrases (CLOSINGS, one file per way of writing). Pure; tests:
 * tests/voice-closing.test.mjs.
 */

export const END_DELAY_SECONDS = { min: 2, max: 10, default: 3 };
/** A long sentence that happens to contain "that's all" is not a goodbye. */
export const MAX_GOODBYE_WORDS = 8;

export const CLOSING_TRIGGERS = {
  CALLER_GOODBYE: "caller_goodbye",
  NO_MORE_QUESTIONS: "no_more_questions",
  AGENT_FAREWELL: "agent_farewell",
};

/**
 * An agent's call-ending settings in their clean form. Never throws (a call is waiting).
 * @param {{autoEndCalls?: unknown, endCallDelaySeconds?: unknown}} [row]
 * @returns {{autoEndCalls: boolean, endCallDelaySeconds: number}}
 */
export function normalizeCallEnding(row = {}) {
  const delay = Number(row?.endCallDelaySeconds);
  return {
    autoEndCalls: row?.autoEndCalls !== false,
    endCallDelaySeconds: Number.isInteger(delay) && delay >= END_DELAY_SECONDS.min && delay <= END_DELAY_SECONDS.max ? delay : END_DELAY_SECONDS.default,
  };
}

/**
 * What is wrong with call-ending settings being saved, as translatable codes (validation:callEnding.*).
 * @param {{autoEndCalls?: unknown, endCallDelaySeconds?: unknown}} patch
 * @returns {Array<{code: string, vars?: object}>}
 */
export function callEndingProblems(patch) {
  const problems = [];
  if (patch.autoEndCalls !== undefined && typeof patch.autoEndCalls !== "boolean") problems.push({ code: "autoEndInvalid" });
  if (patch.endCallDelaySeconds !== undefined) {
    const delay = patch.endCallDelaySeconds;
    if (!Number.isInteger(delay) || delay < END_DELAY_SECONDS.min || delay > END_DELAY_SECONDS.max) {
      problems.push({ code: "delayRange", vars: { min: END_DELAY_SECONDS.min, max: END_DELAY_SECONDS.max } });
    }
  }
  return problems;
}

const wordCount = (text) => String(text ?? "").trim().split(/\s+/).filter(Boolean).length;

/**
 * Has this turn brought the call to its end?
 *
 * @param {object} args
 * @param {{autoEndCalls?: boolean, endCallDelaySeconds?: number}} args.settings  the agent's settings
 * @param {string} args.callerText       what the caller just said
 * @param {string} args.intent           lib/voice/intent.js classification of it
 * @param {string|null} args.previousReply  what the agent said BEFORE this (did it ask "anything else?")
 * @param {string} args.reply            what the agent answered now (as heard)
 * @param {boolean} [args.requestOpen]   a request is half-taken
 * @param {boolean} [args.onHold]        the caller asked the agent to wait
 * @param {boolean} [args.handoff]       the turn is passing the caller to a person
 * @param {boolean} [args.failed]        the turn failed
 * @param {boolean} [args.interrupted]   the caller cut the reply off
 * @returns {{end: false} | {end: true, trigger: string, sayClosingLine: boolean, delayMs: number}}
 */
export function decideCallEnd({ settings, callerText, intent, previousReply = null, reply = "", requestOpen = false, onHold = false, handoff = false, failed = false, interrupted = false }) {
  const { autoEndCalls, endCallDelaySeconds } = normalizeCallEnding(settings);
  if (!autoEndCalls || failed || interrupted || requestOpen || onHold || handoff) return { end: false };
  // The agent asked something: wait for the answer, whatever the caller said before it.
  if (lastSentence(reply).question) return { end: false };

  const farewell = saysFarewell(reply);
  let trigger = null;
  if (intent === GOODBYE_INTENT && wordCount(callerText) <= MAX_GOODBYE_WORDS) trigger = CLOSING_TRIGGERS.CALLER_GOODBYE;
  else if (previousReply && asksAnythingElse(previousReply) && isDecliningMore(callerText)) trigger = CLOSING_TRIGGERS.NO_MORE_QUESTIONS;
  else if (farewell) trigger = CLOSING_TRIGGERS.AGENT_FAREWELL;
  if (!trigger) return { end: false };
  return { end: true, trigger, sayClosingLine: !farewell, delayMs: endCallDelaySeconds * 1000 };
}
