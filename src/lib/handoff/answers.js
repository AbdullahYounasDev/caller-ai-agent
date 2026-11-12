import { asksQuestion, isDecliningMore } from "@/lib/phrases";
import { isAcknowledgement } from "@/lib/agent/query";

/**
 * DID THE CALLER ANSWER THE AGENT — or ask it something the documents could not answer?
 *
 * The handoff decision (decide.js) counts "the agent did not understand" in a row, and one of its signals is "a
 * real question that matched no document". A name, a phone number, "no thanks" or "okay" is not a question and can
 * never match a document, yet intent.js labels every message that is not a greeting or a goodbye a "question".
 * Found on three real calls (CLAUDE.md §6.26): "My name is Abdullah Yunus" and then "Oui." (a mis-heard answer to
 * "May I have your phone number?") counted as two failures in a row and passed the caller to a person while they
 * were still talking.
 *
 * So the question is asked here, by rules, with no model call. It errs toward COUNTING: a caller who asks a bare
 * topic ("opening hours") after "how can I help you?" is still a question — a missed failure costs a little patience,
 * a wrongly-counted answer sends a caller who was understood to a stranger.
 *
 * Pure (tests/handoff-answers.test.mjs). English, Urdu script and Roman Urdu, as the callers speak.
 */

const START = "(?<![\\p{L}\\p{M}])";
const END = "(?![\\p{L}\\p{M}])";
const edged = (source) => new RegExp(`${START}(?:${source})${END}`, "iu");

/** A question the phrase lists do not carry: "do you deliver", "tell me the price", "کیا"-less requests to be told. */
const ASKS_TO_BE_TOLD = new RegExp(
  [
    // English: an auxiliary that opens a question, or a plain request for information
    `^\\s*(?:do|does|did|can|could|would|will|is|are|am|have|has|should|may)\\s+(?:you|there|it|the|your|i|we|they|this|that|any)${END}`,
    `${START}(?:tell me|let me know|any idea|how much|how many|i (?:want|would like|'d like|wanna) to (?:know|ask|find out))${END}`,
    // Urdu script: "بتائیں", "بتا دیں", "معلوم کرنا"
    `${START}(?:بتا(?:ئیں|ئے|دیں|یں|ؤ|سکتے|سکتی)|معلوم کرنا)${END}`,
    // Roman Urdu
    `${START}(?:bata(?:o|en|iye|yen)?|maloom karna|pata karna)${END}`,
  ].join("|"),
  "iu"
);

/** @returns {boolean} the message is, or reads like, a question or a request for information */
export function looksLikeQuestion(message) {
  const text = String(message ?? "");
  return asksQuestion(text) || ASKS_TO_BE_TOLD.test(text);
}

const DETAIL_WORD = "name|number|no|address|e-?mail|location|landmark|city|area|street|surname|contact";
/** What the agent says when it needs a detail from the caller — a name, a number, an address, a day, a choice. */
const ASKS_FOR_DETAIL = edged(
  [
    "may i (?:have|get|take|know)",
    // Deliberately NOT "could you say/give/tell…": "could you say that another way?" is the agent asking to be told again,
    // and what comes back to that is another attempt at a question (it counts if it fails), not an answer.
    "(?:could|can) i (?:please )?(?:get|have|take)",
    "(?:could|can|would) you (?:please )?spell",
    `(?:your|the) (?:\\p{L}+ ){0,3}(?:${DETAIL_WORD})`,
    "what(?:'s| is) your",
    "which (?:day|date|time|dish|item|branch|location|area|one)",
    "what time|how many|when would|when (?:do|can) you",
    "pick ?up or delivery|delivery or (?:pick ?up|collection)|take ?away or|dine[- ]in or",
    // Urdu script
    "آپ کا\\s+(?:\\S+\\s+){0,2}(?:نام|نمبر|فون|پتہ|پتا|ایڈریس|ای میل)|نام اور|رابطے کی|کس وقت|کون سا دن|کتنے (?:لوگ|افراد)|پک اپ یا ڈیلیوری|ڈیلیوری یا پک اپ",
    // Roman Urdu
    "aap ka\\s+(?:\\w+\\s+){0,2}(?:naam|number|pata|address|email)|naam aur|kis waqt|kitne log|pickup ya delivery",
  ].join("|")
);

/** The last `count` sentences of something said, whether or not it ended on its question mark (a cut-off reply does not). */
function tail(reply, count) {
  const parts = (String(reply ?? "").match(/[^.!?۔؟]+[.!?۔؟]*/g) ?? []).filter((p) => /\p{L}/u.test(p));
  return parts.slice(-count).join(" ");
}

/**
 * Did the agent's last words ask the caller for a detail of their own? Looks at the last two sentences, and not for a
 * question mark: a reply cut off by the caller (voice/session.js stores only what was heard) has none.
 * @param {string|null|undefined} reply what the agent said
 */
export function askedForDetail(reply) {
  const text = tail(reply, 2);
  return Boolean(text) && ASKS_FOR_DETAIL.test(text);
}

const SAYS_OWN_DETAILS = edged(
  [
    `my (?:\\p{L}+ ){0,2}(?:${DETAIL_WORD})`,
    "(?:name is|i am called|i'?m called|call me|this is|i live|we live|we are (?:at|in|near)|i(?:'m| am) (?:at|in|from|near|staying))",
    "میرا\\s+(?:\\S+\\s+){0,2}(?:نام|نمبر|پتہ|پتا|ایڈریس|ای میل)|(?:رہتا|رہتی|رہتے)\\s+ہوں|ہمارا\\s+(?:نام|پتہ|پتا)",
    "mera\\s+(?:\\w+\\s+){0,2}(?:naam|number|pata|address|email)|(?:rehta|rehti|rehte)\\s+(?:hoon|hun|hain)",
  ].join("|")
);
const DIGIT = /[0-9٠-٩۰-۹]/g;
const SPOKEN_DIGITS = new Set([
  "zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "صفر", "ایک", "دو", "تین", "چار", "پانچ", "چھ", "سات", "آٹھ", "نو",
  "sifar", "ek", "do", "teen", "char", "paanch", "panch", "chhe", "chay", "saat", "aath", "nau",
]);

/**
 * Is the caller giving details about themselves — a name, an address, a phone number (digits, or said digit by digit)?
 * @param {string} message
 */
export function statesPersonalDetails(message) {
  const text = String(message ?? "");
  if (SAYS_OWN_DETAILS.test(text)) return true;
  if ((text.match(DIGIT) ?? []).length >= 6) return true;
  const words = text.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const spoken = words.filter((w) => SPOKEN_DIGITS.has(w)).length;
  return spoken >= 5 && spoken / words.length >= 0.6;
}

/**
 * The one question this file answers.
 *
 * @param {object} args
 * @param {string} args.message        what the caller just said
 * @param {string|null} [args.previousReply]  what the agent said before it (as heard — an interrupted reply is cut short)
 * @returns {boolean} true: the caller answered, declined or acknowledged — there is nothing for the documents to
 *   answer, so it is not a sign the agent failed to understand. false: a question, or something we cannot place.
 */
export function answersAgentQuestion({ message, previousReply = null }) {
  const text = String(message ?? "").trim();
  if (!text) return false;
  // "No thanks", "okay", "that's all": nothing to look up, whatever came before.
  if (isDecliningMore(text) || isAcknowledgement(text)) return true;
  // A question is never an answer — "do you deliver to Gulberg?" right after "may I have your name?".
  if (looksLikeQuestion(text)) return false;
  // Giving one's own details needs no question before it ("my name is…", a phone number).
  if (statesPersonalDetails(text)) return true;
  // Anything that is not a question, said right after the agent asked for a detail — even one the recogniser garbled.
  return askedForDetail(previousReply);
}
