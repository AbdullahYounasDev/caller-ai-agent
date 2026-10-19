import { parseYesNo } from "./validate";

/**
 * THE SMALL WORDS OF TAKING A REQUEST — pure, free, no model call.
 *
 * Wanting an appointment, changing one's mind, saying "yes, that's right" and declining an
 * optional question are the four things a conversation about a request keeps doing, and a
 * model call per turn to notice them would spend scarce quota (§8 limitation 3) and
 * phone-call latency on something a rule does perfectly well. These rules are deliberately
 * BROAD for starting (a missed start means the customer's details are never taken, so the
 * marker in marker.js backs this up) and deliberately NARROW for cancelling (a false
 * cancel throws away what a customer just spent a minute saying).
 *
 * English, Urdu script and Roman Urdu — the way people in Pakistan actually write and say
 * it. JavaScript's \b does not see Arabic-script letters as word characters, so every
 * pattern is delimited with Unicode-aware edges instead.
 *
 * Tested in tests/collect-phrases.test.mjs.
 */

const START = "(?<![\\p{L}\\p{M}])";
const END = "(?![\\p{L}\\p{M}])";
const edged = (source) => new RegExp(`${START}(?:${source})${END}`, "iu");

// ── starting ────────────────────────────────────────────────────────────

const APPOINTMENT = edged(
  [
    // English
    "appointments?|book(?:ing|ed)?|reserv(?:e|ation|ations)|schedule|slot|visit|see (?:the |a )?(?:doctor|dentist|dr)|come in|table for|check ?up",
    // Urdu script
    "اپائنٹمنٹ|اپوائنٹمنٹ|بکنگ|بک کر|بک کرنا|بک کرنی|ریزرویشن|ملاقات|ملنا|ملنی|دکھانا|دکھوانا|وقت لینا|وقت چاہیے|وقت چاہئے|میز",
    // Roman Urdu
    "book (?:karna|karni|karwana|kar do|kardo|karein|karen)|booking|waqt (?:lena|chahiye|milega)|time (?:lena|chahiye|mil sakta)|milna|milni|dikhana|dikhani|dikhwana|reserve (?:karna|karni|karwana)|table chahiye",
  ].join("|")
);

const CALLBACK = edged(
  [
    "call me back|call back|callback|ring me|phone me|contact me|get back to me|someone (?:to )?call|call me",
    "واپس کال|کال بیک|مجھے کال کر|کال کر(?:یں|ین|دیں|دیں|لیں)|فون کر(?:یں|ین|دیں)|رابطہ کر(?:یں|ین)",
    "wapas call|waapis call|call ?back|mujhe call (?:karen|karein|kar do|kardo|karna)|call karein|call karen|phone karen|phone karein|rabta karen|rabta karein|rabta kar",
  ].join("|")
);

// Changing or cancelling something that already exists is NOT asking for a new one: the
// agent has no booking to look up (§6.11), so it must not start collecting a second one.
const MODIFYING_EXISTING = edged(
  "cancel (?:my|the|our) (?:appointment|booking|reservation)|reschedule|change (?:my|the) (?:appointment|booking|time)|postpone|" +
    "میری (?:اپائنٹمنٹ|بکنگ) (?:منسوخ|تبدیل|ملتوی)|اپائنٹمنٹ (?:منسوخ|تبدیل|ملتوی)|" +
    "appointment (?:cancel|change|badalni|badalna)|booking (?:cancel|change)|appointment ka time badal|cancel karna hai"
);

/**
 * Which kind of request does this message ask for, among the types the business switched
 * on? Null when it asks for none (or for a change to an existing one).
 *
 * @param {string} message
 * @param {string[]} enabledTypes e.g. ["appointment", "callback"]
 * @returns {string|null}
 */
export function detectStartType(message, enabledTypes) {
  const text = String(message ?? "");
  if (!text.trim() || MODIFYING_EXISTING.test(text)) return null;

  // Both can match ("call me back to book an appointment" / "book an appointment and call
  // me to confirm"): the thing asked for FIRST is the thing asked for.
  const first = (re) => text.search(re);
  const found = [];
  if (enabledTypes.includes("callback")) found.push({ type: "callback", at: first(CALLBACK) });
  if (enabledTypes.includes("appointment")) found.push({ type: "appointment", at: first(APPOINTMENT) });
  const hits = found.filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  return hits[0]?.type ?? null;
}

// ── backing out ─────────────────────────────────────────────────────────

/** Unmistakable: the customer does not want to go on. Also valid while an OPTIONAL question is open. */
const STRONG_CANCEL = edged(
  "cancel (?:it|that|this|everything|the request)|forget (?:it|about it|the appointment|the booking)|stop|don'?t want (?:to|any)|do not want|" +
    "i changed my mind|changed my mind|" +
    "منسوخ کر|نہیں چاہیے|نہیں چاہئے|اپنا ارادہ بدل|ارادہ بدل گیا|" +
    "cancel kar|cancel karo|nahi chahiye|nahin chahiye|mera irada badal|irada badal gaya"
);

/** Could mean "skip this question" or "forget it all" — only the second when the question was required. */
const WEAK_CANCEL = edged(
  "never ?mind|leave it|not now|no thanks|no thank you|maybe later|later|" +
    "رہنے دیں|رہنے دو|چھوڑیں|چھوڑو|کوئی بات نہیں|ابھی نہیں|بعد میں|" +
    "rehne (?:do|den|dein)|chor(?:o| do| den)|chhor(?:o| do| den)|koi baat nahi|abhi nahi|baad mein"
);

/**
 * @param {string} message
 * @param {{askingOptional?: boolean}} [context] whether the question just asked may be skipped
 * @returns {boolean}
 */
export function isCancel(message, { askingOptional = false } = {}) {
  const text = String(message ?? "");
  if (STRONG_CANCEL.test(text)) return true;
  // A weak "never mind" in answer to an optional question just declines THAT question.
  return !askingOptional && WEAK_CANCEL.test(text) && text.trim().split(/\s+/).length <= 5;
}

/** "no", "none", "skip", "nothing", "koi nahi" — declining a question that may be declined. */
const SKIP = edged(
  "skip|pass|none|nothing|nope|no|not needed|not necessary|no need|don'?t have|do not have|" +
    "نہیں|نہ|کوئی نہیں|کچھ نہیں|ضرورت نہیں|نہیں ہے|" +
    "nahi|nahin|koi nahi|kuch nahi|zaroorat nahi|zarurat nahi|nahi hai"
);

/**
 * @param {string} message
 * @returns {boolean} the customer declined the optional question just asked
 */
export function isSkip(message) {
  const text = String(message ?? "").trim();
  if (!text) return false;
  // A short refusal. A long message that happens to contain "no" is an answer.
  if (text.split(/\s+/).length > 6) return false;
  return SKIP.test(text) || WEAK_CANCEL.test(text);
}

// ── confirming ──────────────────────────────────────────────────────────

const CONFIRM_PHRASE = edged(
  "go ahead|confirm(?:ed)?|book it|that'?s right|that is right|that'?s correct|that is correct|sounds good|all correct|looks good|submit|please do|do it|" +
    "کر دیں|کر دو|کردیں|کردو|بالکل صحیح|سب ٹھیک|ٹھیک ہے|صحیح ہے|درست ہے|" +
    "kar do|kardo|kar dein|kar den|karein|sab theek|bilkul sahi|sahi hai|theek hai|thik hai"
);

const DENY_PHRASE = edged(
  "not correct|incorrect|wrong|mistake|not right|that'?s not|change|correct (?:that|it)|" +
    "غلط|تبدیل|درست نہیں|صحیح نہیں|ٹھیک نہیں|" +
    "galat|ghalat|badal|theek nahi|thik nahi|sahi nahi|sahih nahi"
);

/**
 * The customer's answer to "is all of that correct?".
 * @param {string} message
 * @returns {"yes"|"no"|null}
 */
export function confirmationOf(message) {
  const text = String(message ?? "").trim();
  if (!text) return null;
  const short = text.split(/\s+/).length <= 6;
  // "no, the phone number is wrong" / "nahi, time galat hai" — a denial wins over a stray "ٹھیک".
  if (DENY_PHRASE.test(text)) return "no";
  const yn = parseYesNo(text);
  if (yn === "no") return "no";
  if (yn === "yes") return "yes";
  if (short && CONFIRM_PHRASE.test(text)) return "yes";
  return null;
}

// ── asking for a person ─────────────────────────────────────────────────

/** True when the message looks like a QUESTION rather than an answer. */
export function looksLikeQuestion(message) {
  const text = String(message ?? "").trim();
  if (/[?؟]\s*$/.test(text)) return true;
  return edged("what|when|where|which|who|why|how|do you|can you|are you|is there|kya|kab|kahan|kaun|kyun|kaise|kitna|kitne|کیا|کب|کہاں|کون|کیوں|کیسے|کتنا|کتنے|کتنی").test(text.split(/[.!۔]/)[0].slice(0, 40));
}
