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
 * Pure (tests/voice-intent.test.mjs). English + Italian, the active locales (§7).
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

const HUMAN_REQUEST =
  /\b(speak|talk|put me through|transfer me|connect me)\b.{0,30}\b(human|person|someone|somebody|agent|operator|representative|staff|manager)\b|\b(real|live) (person|human|agent)\b|\boperator\b|\b(parlare|passarmi|passami)\b.{0,30}\b(operatore|persona|qualcuno|umano|responsabile)\b|\boperatore\b/i;
const GOODBYE =
  /\b(bye|goodbye|good bye|see you|that'?s all|that is all|nothing else|have a (nice|good) day|arrivederci|ciao ciao|a presto|buona giornata|buona serata|è tutto|basta così|nient'?altro)\b/i;
const GREETING_ONLY =
  /^\s*(hi|hello|hey|good (morning|afternoon|evening)|ciao|salve|buongiorno|buonasera|pronto)[\s,.!]*(there|everyone)?[\s,.!]*$/i;

/**
 * @param {object} turn
 * @param {string} turn.callerText   what the caller said
 * @param {string[]} [turn.sources]  document titles retrieval handed the model
 * @param {null|"heuristic"|"empty"} [turn.trigger] whether the follow-up step fired (§6.19)
 * @param {string|null} [turn.rewriteStatus]
 * @param {boolean} [turn.failed]
 * @returns {{intent: string, outcome: string, topic: string|null}}
 */
export function classifyTurn({ callerText, sources = [], trigger = null, rewriteStatus = null, failed = false }) {
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
  else if ([INTENTS.GREETING, INTENTS.ACKNOWLEDGEMENT, INTENTS.GOODBYE].includes(intent)) {
    outcome = OUTCOMES.CONVERSATIONAL;
  } else outcome = OUTCOMES.NO_KNOWLEDGE;

  const topic = sources.length ? humanizeTitle(sources[0]) || sources[0] : null;
  return { intent, outcome, topic };
}
