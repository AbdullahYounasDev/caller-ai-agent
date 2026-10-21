import { zonedNow, checkHours } from "@/lib/collect/validate";
import { handoffAvailable } from "./config";
import { asksForHuman, isProfileQuestion, matchedTopic, rankContacts, repeatsPrevious, saysNotUnderstood } from "./phrases";

/**
 * WHEN DOES THE AGENT PASS A CALLER TO A PERSON — the one decision, as a pure function.
 *
 * The brain (respond.js) calls it once per customer message, with what it knows about the turn;
 * it answers with what should happen and the conversation's new handoff state. It never speaks,
 * never places a call and never touches the database — the model WORDS the outcome (prompt.js
 * buildHandoffInstruction) and the transport PLACES the transfer (voice/session.js, and later
 * Twilio): the same split as taking a request (collect/engine.js), for the same reason —
 * behaviour that must be exact is code, not a model's mood.
 *
 *   caller asks for a person ─────────────────────────────▶ handoff ("asked")
 *   caller says a topic the owner marked ("complaint") ───▶ handoff ("topic")
 *   the agent fails to understand / help, again and again:
 *     1st time ─▶ rephrase   (say so honestly, ask for it another way)
 *     Nth time ─▶ handoff    (N = the owner's `afterMisses`)
 *   handoff while the business is closed ─────────────────▶ unavailable → offer a call-back
 *
 * "Fails to understand" is judged from signals that need no model call: a real question the
 * documents had nothing for (and the business profile does not cover), the caller saying they
 * are not being understood, or saying the same thing again. The voice session adds the one only
 * it can see — speech it could not make out at all (session.js).
 *
 * Pure (tests/handoff.test.mjs).
 */

export const HANDOFF_STATE_VERSION = 1;

/** @returns {object} the state of a conversation nobody has been passed on from */
export function newHandoffState() {
  return { v: HANDOFF_STATE_VERSION, misses: 0, status: null, reason: null, at: null };
}

/** Normalise whatever is stored. Never throws. */
export function readHandoffState(raw) {
  const base = newHandoffState();
  if (!raw || typeof raw !== "object" || raw.v !== HANDOFF_STATE_VERSION) return base;
  return {
    ...base,
    misses: Number.isInteger(raw.misses) && raw.misses > 0 ? Math.min(raw.misses, 99) : 0,
    status: raw.status === "handed_off" ? "handed_off" : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
    at: typeof raw.at === "number" ? raw.at : null,
  };
}

/**
 * What the turn looked like — computed by the caller from things it already has.
 * @typedef {object} TurnSignals
 * @property {boolean} question      the message is a real question (not a greeting, thanks or goodbye)
 * @property {boolean} hasSources    retrieval found something to answer from
 * @property {boolean} collecting    a request (appointment…) is being taken this turn
 */

/**
 * @param {object} args
 * @param {object} args.config            normalised handoff settings (handoff/config.js)
 * @param {{timezone?: string, hours?: unknown}} args.agent
 * @param {object} args.state             readHandoffState(...)
 * @param {string} args.message           the customer's latest message
 * @param {string|null} [args.previousMessage]  the customer's message before it
 * @param {TurnSignals} args.turn
 * @param {number} args.nowMs
 * @param {boolean} [args.callbackAvailable] the business takes call-back requests
 * @param {boolean} [args.unheard]        voice only: speech that could not be made out
 * @returns {{state: object, action: null | {kind: "rephrase"}
 *   | {kind: "handoff", reason: string, contacts: object[]}
 *   | {kind: "unavailable", reason: string, callback: boolean, contacts: object[]}
 *   | {kind: "handed_off"}}}
 */
export function decideHandoff({ config, agent, state: stored, message, previousMessage = null, turn, nowMs, callbackAvailable = false, unheard = false }) {
  const state = readHandoffState(stored);
  if (!handoffAvailable(config)) return { state, action: null };

  // Already passed on (a chat has no hang-up): do not forward twice; the model just stays brief.
  if (state.status === "handed_off") return { state, action: { kind: "handed_off" } };

  const ranked = () => rankContacts(config.contacts, message);
  const forward = (reason, next) => {
    // Closed: there is nobody to pick up, so promising a transfer would be a lie.
    if (config.outsideHours === "callback" && isClosedNow(agent, nowMs)) {
      return { state: { ...next, misses: 0 }, action: { kind: "unavailable", reason: "closed", callback: callbackAvailable, contacts: [] } };
    }
    return { state: { ...next, status: "handed_off", reason, at: nowMs, misses: 0 }, action: { kind: "handoff", reason, contacts: ranked() } };
  };

  // 1–2. Deterministic: the caller asked, or said a word the owner always forwards on.
  if (config.whenCallerAsks && asksForHuman(message)) return forward("asked", state);
  const topic = matchedTopic(message, config.topics);
  if (topic) return forward("topic", state);

  // 3. The agent not understanding, or not being able to help — counted in a row.
  const complaint = saysNotUnderstood(message);
  const repeated = repeatsPrevious(message, previousMessage);
  const missed =
    unheard ||
    complaint ||
    repeated ||
    (turn.question && !turn.hasSources && !turn.collecting && !isProfileQuestion(message));

  if (!missed) return { state: { ...state, misses: 0 }, action: null };

  const misses = state.misses + 1;
  const next = { ...state, misses };
  if (misses >= config.afterMisses) return forward(complaint || repeated ? "frustrated" : "not_understood", next);
  return { state: next, action: { kind: "rephrase" } };
}

/** Is the business closed right now? No hours on record means "can't tell" = open. */
export function isClosedNow(agent, nowMs) {
  const { date, time } = zonedNow(nowMs, agent?.timezone || "UTC");
  return !checkHours(agent?.hours ?? null, date, time).ok;
}

/**
 * A few plain lines a person can read in seconds when a call is put through to them — who is
 * calling about what, and what the agent already took down. Built by rules (no model call),
 * in English: it is for staff, not for the caller.
 *
 * @param {object} args
 * @param {string} args.reason       "asked" | "topic" | "not_understood" | "frustrated"
 * @param {string[]} args.callerMessages  the caller's last few messages, oldest first
 * @param {Array<{label: string, display: string}>} [args.details]  what a request taking has collected
 * @returns {string}
 */
export function summariseForPerson({ reason, callerMessages = [], details = [] }) {
  const why = {
    asked: "The caller asked to speak to a person.",
    topic: "The caller raised a topic you asked to be passed on.",
    not_understood: "The assistant could not understand or answer the caller.",
    frustrated: "The caller said they were not being understood.",
  }[reason] ?? "The call was passed on.";
  const said = callerMessages
    .map((m) => String(m).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-3)
    .map((m) => `“${m.length > 140 ? `${m.slice(0, 139)}…` : m}”`);
  const lines = [why];
  if (said.length) lines.push(`Caller said: ${said.join(" · ")}`);
  if (details.length) lines.push(`Already taken: ${details.map((d) => `${d.label} ${d.display}`).join("; ")}`);
  return lines.join("\n");
}
