import { isAcknowledgement } from "@/lib/agent/query";
import { humanizeTitle } from "@/lib/agent/chunk";

/**
 * WHAT DID THE CALLER WANT, AND DID THEY GET IT? — one label pair per turn, for the
 * call log and the analytics that will read it.
 *
 * DELIBERATELY RULE-BASED, never a model call. A classifier model would cost a request
 * on every turn against a free tier of ~20 a day (§8 limitation 3) and add latency to
 * the hot path for something no caller hears. And most of the useful signal is
 * already known for free: retrieval said whether the knowledge base had an answer
 * (sources), the follow-up step said whether the turn depended on the previous one
 * (§6.19), and a short regex catches "can I talk to a person". If a semantic intent
 * taxonomy is ever needed ("booking", "complaint"…), it belongs in an offline job over
 * call_turns — not on the call.
 *
 * Pure (tests/voice-intent.test.mjs). English and Urdu (in Urdu script and Roman letters), the
 * two active languages (§7).
 */

export const INTENTS = {
  QUESTION: "question",
  FOLLOWUP: "followup",
  GREETING: "greeting",
  ACKNOWLEDGEMENT: "acknowledgement",
  GOODBYE: "goodbye",
  HUMAN_REQUEST: "human_request",
};

export const OUTCOMES = {
  /** The reply was grounded in at least one of the business's documents. */
  ANSWERED: "answered",
  /** A real question the knowledge base had nothing for — the list a business should read. */
  NO_KNOWLEDGE: "no_knowledge",
  /** Small talk: greetings, thanks, goodbyes. Nothing to answer. */
  CONVERSATIONAL: "conversational",
  /** The caller asked for a person. Today the agent can only promise it (§6.11). */
  HANDOFF_REQUESTED: "handoff_requested",
  FAILED: "failed",
};

// JavaScript's \b does not see Arabic-script letters as word characters, so Urdu patterns are
// delimited with Unicode-aware edges instead.
const EDGE_START = "(?<![\\p{L}\\p{M}])";
const EDGE_END = "(?![\\p{L}\\p{M}])";
const edged = (source) => new RegExp(`${EDGE_START}(?:${source})${EDGE_END}`, "iu");

const HUMAN_REQUEST = edged(
  // English
  "(?:speak|talk|put me through|transfer me|connect me)\\b.{0,30}\\b(?:human|person|someone|somebody|agent|operator|representative|staff|manager)|" +
    "(?:real|live) (?:person|human|agent)|operator|" +
    // Urdu script: "کسی انسان سے بات", "آپریٹر", "مینیجر سے بات کرنی ہے", "کسی سے بات کروائیں"
    "(?:انسان|بندے|شخص|کسی|مینیجر|منیجر|مالک|عملے|اسٹاف)\\s+(?:سے\\s+)?(?:بات|ملوا|ملا)|آپریٹر|" +
    // Roman Urdu: "kisi insan se baat", "operator", "manager se baat karni hai"
    "(?:insan|banday|bande|shakhs|kisi|manager|malik|staff)\\s+(?:se\\s+)?(?:baat|milwa|mila)"
);
const GOODBYE = edged(
  "bye|goodbye|good bye|see you|that'?s all|that is all|nothing else|have a (?:nice|good) day|" +
    "خدا حافظ|اللہ حافظ|بس اتنا ہی|بس یہی|اور کچھ نہیں|شکریہ، بس|" +
    "khuda hafiz|allah hafiz|bas itna hi|bas yehi|aur kuch nahi|bas shukriya"
);
const GREETING_ONLY = new RegExp(
  "^\\s*(?:hi|hello|hey|good (?:morning|afternoon|evening)|سلام|السلام علیکم|آداب|ہیلو|salam|assalam o alaikum|assalamualaikum|assalam alaikum|aoa)[\\s,.!۔،]*(?:there|everyone)?[\\s,.!۔،]*$",
  "iu"
);

/**
 * @param {object} turn
 * @param {string} turn.callerText   what the caller said
 * @param {string[]} [turn.sources]  document titles retrieval handed the model
 * @param {null|"heuristic"|"empty"} [turn.trigger] whether the follow-up step fired (§6.19)
 * @param {string|null} [turn.rewriteStatus]
 * @param {boolean} [turn.failed]
 * @param {string|null} [turn.requestState] what taking a request did this turn (respond().collection.state)
 * @returns {{intent: string, outcome: string, topic: string|null}}
 */
export function classifyTurn({ callerText, sources = [], trigger = null, rewriteStatus = null, failed = false, requestState = null }) {
  const text = String(callerText ?? "").trim();

  let intent = INTENTS.QUESTION;
  if (HUMAN_REQUEST.test(text)) intent = INTENTS.HUMAN_REQUEST;
  else if (GOODBYE.test(text)) intent = INTENTS.GOODBYE;
  else if (GREETING_ONLY.test(text)) intent = INTENTS.GREETING;
  else if (isAcknowledgement(text)) intent = INTENTS.ACKNOWLEDGEMENT;
  // A follow-up is a turn whose search had to be rewritten from the conversation —
  // "and the Pro one?" — not merely one that fired the trigger and came back unchanged.
  else if (trigger && rewriteStatus === "rewritten") intent = INTENTS.FOLLOWUP;

  let outcome;
  if (failed) outcome = OUTCOMES.FAILED;
  else if (intent === INTENTS.HUMAN_REQUEST) outcome = OUTCOMES.HANDOFF_REQUESTED;
  else if (sources.length) outcome = OUTCOMES.ANSWERED;
  // Giving a phone number to a booking is not a question the documents failed to answer: it
  // used to be logged "unanswered" (and was searched for nothing — respond.js skips that now).
  else if (requestState && requestState !== "idle") outcome = OUTCOMES.CONVERSATIONAL;
  else if ([INTENTS.GREETING, INTENTS.ACKNOWLEDGEMENT, INTENTS.GOODBYE].includes(intent)) {
    outcome = OUTCOMES.CONVERSATIONAL;
  } else outcome = OUTCOMES.NO_KNOWLEDGE;

  const topic = sources.length ? humanizeTitle(sources[0]) || sources[0] : null;
  return { intent, outcome, topic };
}
