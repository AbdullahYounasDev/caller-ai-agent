import { detectOpener } from "@/lib/phrases";

/**
 * THE SMALL WORDS OF ASKING FOR A PERSON — pure, free, no model call (tests/handoff.test.mjs).
 *
 * Four rules, all rule-based for the reason intent.js gives: a model call per turn would spend
 * scarce quota and phone-call latency on something a pattern does well. English, Urdu script
 * and Roman Urdu, the way callers actually speak. JavaScript's \b does not see Arabic-script
 * letters, so every pattern uses Unicode-aware edges.
 */

const START = "(?<![\\p{L}\\p{M}])";
const END = "(?![\\p{L}\\p{M}])";
const edged = (source) => new RegExp(`${START}(?:${source})${END}`, "iu");

const PERSON = "human|person|someone|somebody|agent|operator|representative|rep|staff|manager|supervisor|senior|lead|owner|boss|receptionist|team|executive|specialist|consultant|advisor|adviser";

const ASKS_FOR_PERSON = edged(
  [
    // English: "I want to speak to a person", "can I talk to someone", "put me through to the manager"
    `(?:speak|talk|chat|connect|put me through|transfer|forward|pass)\\b.{0,25}\\b(?:${PERSON})`,
    "(?:real|live|actual) (?:person|human|agent)",
    `(?:i (?:want|need|would like|'d like)|can i (?:get|have)|get me|give me) (?:a |an |the |to )?(?:${PERSON})`,
    "customer (?:service|care|support)|operator|hand me over|call (?:me )?(?:a|the) (?:manager|supervisor)",
    // Urdu script: "کسی انسان سے بات", "مینیجر سے بات کروائیں", "کسی کو لائن پر دیں", "آپریٹر"
    "(?:انسان|بندے|شخص|کسی|مینیجر|منیجر|سپروائزر|سینئر|نمائندے|ریپریزنٹیٹو|مالک|عملے|اسٹاف|ٹیم)\\s+(?:سے\\s+)?(?:بات|ملوا|ملا|رابطہ)",
    "(?:کسی|انسان|بندے)\\s+(?:کو\\s+)?لائن\\s+پر|آپریٹر|کسٹمر سروس|ریسپشن",
    // Roman Urdu: "kisi insan se baat", "manager se baat karni hai", "kisi ko line par dein"
    "(?:insan|banday|bande|banda|shakhs|kisi|manager|supervisor|senior|representative|malik|staff|team|receptionist)\\s+(?:se\\s+)?(?:baat|milwa|mila|rabta)",
    "(?:kisi|insan|banday)\\s+(?:ko\\s+)?line\\s+par|customer service|operator",
  ].join("|")
);

/**
 * @param {string} message
 * @returns {boolean} the caller is asking to be put through to a person
 */
export function asksForHuman(message) {
  return ASKS_FOR_PERSON.test(String(message ?? ""));
}

const NOT_UNDERSTOOD = edged(
  [
    // English
    "you(?:'re| are)? (?:not|n't) (?:understand|listening|getting|hearing|following)|you don'?t (?:understand|get it|listen)|you didn'?t (?:understand|get|listen|hear)|" +
      "that(?:'s| is) not what (?:i|we) (?:asked|said|meant|wanted)|not what i (?:asked|said|meant)|i (?:already|just) (?:told|said|asked)|are you (?:even )?listening|" +
      "(?:you )?(?:keep|kept) (?:saying|repeating)|this is (?:useless|pointless|not helping)|(?:what|that) (?:is|are) (?:you|this) (?:saying|talking)",
    // Urdu script
    "آپ (?:سمجھ|سن) نہیں رہے|آپ کو سمجھ نہیں آ|یہ نہیں (?:پوچھا|کہا)|میں نے (?:بتایا|کہا|پوچھا) تھا|میں نے (?:ابھی|پہلے) (?:بتایا|کہا)|کوئی فائدہ نہیں|سنتے ہی نہیں",
    // Roman Urdu
    "aap (?:samajh|sun) nahi rahe|aap ko samajh nahi|ye nahi (?:poocha|pucha|kaha)|maine (?:bataya|kaha|poocha) tha|maine (?:abhi|pehle) (?:bataya|kaha)|koi faida nahi|sunte hi nahi",
  ].join("|")
);

/** @returns {boolean} the caller says, in so many words, that they are not being understood */
export function saysNotUnderstood(message) {
  return NOT_UNDERSTOOD.test(String(message ?? ""));
}

const tokens = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Did the caller say (nearly) the same thing again? People repeat themselves when they were
 * not understood. Needs at least three words each, so "yes" twice is not a complaint.
 */
export function repeatsPrevious(message, previous) {
  const a = tokens(message);
  const b = tokens(previous);
  if (a.length < 3 || b.length < 3) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;
  return shared / new Set([...setA, ...setB]).size >= 0.75;
}

/**
 * @param {string} message
 * @param {string[]} topics the owner's always-forward words ("complaint", "refund", "شکایت")
 * @returns {string|null} the topic that matched
 */
export function matchedTopic(message, topics) {
  const text = String(message ?? "");
  for (const topic of topics ?? []) {
    const escaped = String(topic).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (escaped && new RegExp(`${START}${escaped}${END}`, "iu").test(text)) return topic;
  }
  return null;
}

/**
 * Questions the business PROFILE answers (who are you, what do you do, opening hours,
 * address) — the documents hold nothing for them and that is fine, so they are not a miss.
 */
const PROFILE_QUESTION = edged(
  [
    "who are you|what (?:do|does) (?:you|your (?:company|business|clinic|shop|store)) do|tell me about (?:you|your)|what (?:is|'s) your (?:name|company|business)|" +
      "(?:what|which) (?:are|is) your (?:opening |working |business )?(?:hours|timings?|times?)|when (?:are|do) you (?:open|close)|are you open|(?:open|closed) (?:on|today|now|tomorrow)|where (?:are you|is your)|your (?:address|location)",
    "آپ کون|آپ کا (?:نام|پتہ|ایڈریس)|کھلے|بند|اوقات|ٹائمنگ|کب (?:کھلتے|بند)",
    "aap kaun|aap ka (?:naam|pata|address)|khule|band hain|timing|kab (?:khulte|band)|kahan hain",
  ].join("|")
);

/**
 * @returns {boolean} the question is one the business profile (name, purpose, hours) answers — the
 *   hours and address patterns above, or any generic opener ("tell me about your company",
 *   "aap kya karte hain", "are you a robot?" — the word lists in lib/phrases)
 */
export function isProfileQuestion(message) {
  const text = String(message ?? "");
  return PROFILE_QUESTION.test(text) || detectOpener(text) !== null;
}

/**
 * Which of the contacts does the caller mean? "I want to talk to the senior doctor" picks the
 * contact whose role or name shares a word with the message; otherwise the owner's order stands.
 * Always returns EVERY contact, best first — a transfer that is not answered tries the next.
 *
 * @param {Array<{role: string, name: string}>} contacts
 * @param {string} message
 */
export function rankContacts(contacts, message) {
  const spoken = new Set(tokens(message));
  const score = (contact) => {
    let points = 0;
    for (const word of tokens(`${contact.role} ${contact.name}`)) {
      if (word.length >= 3 && spoken.has(word)) points++;
    }
    return points;
  };
  return contacts
    .map((contact, index) => ({ contact, index, points: score(contact) }))
    .sort((x, y) => y.points - x.points || x.index - y.index)
    .map((x) => x.contact);
}
