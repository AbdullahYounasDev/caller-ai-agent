/**
 * WHAT THE CALLER HEARS BEFORE THEY ARE PASSED TO A PERSON — said by the code, never left to the
 * model (CLAUDE.md §6.26).
 *
 * It used to be the model's job to "tell the caller who they are being connected to". On a real
 * call it did not: it greeted the caller instead, and the line went quiet and was transferred.
 * A caller who is put through without being told hears silence and a ringing tone and thinks the
 * call dropped. So the announcement is a fixed line, filled in for the person being called:
 *
 *   "I'm connecting you to Ali, our Representative. Please stay on the line."
 *   "I'm connecting you to Adan, our Senior. Please stay on the line."
 *
 * The owner may write their own line per language (`escalation.announce` {en?, ur?}) with the
 * placeholders {name} and {role}; empty = the built-in one. If the first person does not answer,
 * `nextContactLine` says so and names the next one.
 *
 * THE WORDS BEFORE IT ARE THE CODE'S TOO (`acknowledgementFor`). The model used to be asked for "one short, warm
 * sentence, no question, no goodbye, do not name anyone" and, on real calls, did not obey: it asked "May I have your phone
 * number?" and "How may I assist you?" right before the announcement, and said "Thank you, goodbye" (in Urdu: "آپ کا شکریہ،
 * الوداع") in the same breath as "connecting you to Adan". A turn that passes the caller to a person now makes no model call
 * at all: the reply is one fixed acknowledgement for the reason, then the announcement.
 *
 * Pure, no I/O: used by the brain (respond.js appends it to the reply, on every channel), by the
 * voice session (the "not answering, trying the next person" line) and by the console (the
 * preview under each person). Tests: tests/handoff-announce.test.mjs.
 */

export const ANNOUNCE_LANGUAGES = ["en", "ur"];
export const ANNOUNCE_MAX_CHARS = 200;
export const ANNOUNCE_PLACEHOLDERS = ["{name}", "{role}"];

const ANY_PLACEHOLDER = /\{[^{}]*\}/g;

/**
 * The built-in lines. Urdu is written in the passive ("آپ کی بات … سے کروائی جا رہی ہے") so it
 * never depends on the gender of the agent's voice.
 */
export const DEFAULT_ANNOUNCE = {
  en: "I'm connecting you to {name}, our {role}. Please stay on the line.",
  ur: "آپ کی بات {name} سے کروائی جا رہی ہے، جو ہمارے {role} ہیں۔ براہِ کرم لائن پر رہیے۔",
};

/** Said for a person who has a name but no role, or a role but no name (built-in line only). */
const DEFAULT_ONE_PART = {
  en: "I'm connecting you to {who}. Please stay on the line.",
  ur: "آپ کی بات {who} سے کروائی جا رہی ہے۔ براہِ کرم لائن پر رہیے۔",
};

/** What stands in for a missing role or name inside an owner's own line. */
const STAND_IN = {
  en: { role: "team member", name: "a member of our team" },
  ur: { role: "ٹیم کے رکن", name: "ہماری ٹیم کے ایک رکن" },
};

/** "{previous} is not answering": put in front of the next person's announcement. */
const NOT_ANSWERING = {
  en: "{previous} isn't available right now.",
  ur: "{previous} اس وقت دستیاب نہیں ہیں۔",
};

/**
 * What is said in front of the announcement, by the reason for the transfer. No question, no goodbye, no name: nothing for
 * the caller to answer and nothing that sounds like the call is over. Urdu is free of gendered verb forms (the voice may be
 * either) and of Latin letters.
 */
const ACKNOWLEDGEMENT = {
  en: { asked: "Of course.", topic: "I understand.", frustrated: "I'm sorry about that.", not_understood: "I'm sorry, I couldn't help with that." },
  ur: { asked: "جی ضرور۔", topic: "جی، بات سمجھ آ گئی۔", frustrated: "معذرت، آپ کو پریشانی ہوئی۔", not_understood: "معذرت، بات واضح نہیں ہو سکی۔" },
};

/**
 * @param {object} args
 * @param {string|null} [args.reason]  asked | topic | frustrated | not_understood (anything else is read as not_understood)
 * @param {"en"|"ur"} args.language    the agent's reply language
 * @returns {string}
 */
export function acknowledgementFor({ reason, language }) {
  const lines = ACKNOWLEDGEMENT[lang(language)];
  return lines[reason] ?? lines.not_understood;
}

/**
 * A role as the owner typed it, in a form that fits an Urdu sentence ("ہمارے …"): a real call showed
 * "…Adan سے کروائی جا رہی ہے، جو ہمارے Representative ہیں" in the chat, half English in an Urdu sentence. CONSISTENCY, not a
 * rescue: measured with the real Urdu voice and Whisper (2026-11-13) the voice already reads a Latin word acceptably
 * ("Representative" was heard as "رپرزنٹیو", "Adan" as "ادان"), so nothing was being spelled out. A fixed table of the
 * usual roles, word by word; a word it does not know is left as typed, and a role already written in Urdu is never touched.
 * Names are the owner's as typed: a name written in Urdu script ("عدنان") is heard correctly, "Adan" as "ادان" — the owner's
 * own line (announce.ur) or an Urdu-script name is the way to say it exactly.
 */
const URDU_ROLE_WORDS = {
  representative: "نمائندے", rep: "نمائندے", manager: "مینیجر", senior: "سینئر", owner: "مالک", doctor: "ڈاکٹر", dr: "ڈاکٹر",
  supervisor: "سپروائزر", receptionist: "ریسپشنسٹ", sales: "سیلز", support: "سپورٹ", lead: "لیڈ", team: "ٹیم", agent: "ایجنٹ",
  specialist: "ماہر", assistant: "اسسٹنٹ", executive: "ایگزیکٹو", accountant: "اکاؤنٹنٹ", director: "ڈائریکٹر", officer: "آفیسر",
  staff: "اسٹاف", admin: "ایڈمن", consultant: "کنسلٹنٹ", advisor: "ایڈوائزر", adviser: "ایڈوائزر", head: "ہیڈ", chef: "شیف",
  customer: "کسٹمر", service: "سروس", care: "کیئر", billing: "بلنگ", technical: "ٹیکنیکل", general: "جنرل", branch: "برانچ", front: "فرنٹ", desk: "ڈیسک",
};

/** @param {string} role @param {"en"|"ur"} l */
function roleFor(role, l) {
  if (l !== "ur" || !role) return role;
  return role.replace(/[A-Za-z]+/g, (word) => URDU_ROLE_WORDS[word.toLowerCase()] ?? word);
}

const lang = (language) => (language === "ur" ? "ur" : "en");
const tidy = (text) =>
  String(text)
    .replace(/\s+([,.!?،۔؟])/g, "$1")
    .replace(/([,،])\s*([.!?۔؟])/g, "$2")
    .replace(/\s{2,}/g, " ")
    .trim();

/**
 * A stored announcement in its clean form: only known languages, trimmed, empty ones dropped.
 * Never throws (a call is waiting).
 * @param {unknown} value
 * @returns {{en?: string, ur?: string}}
 */
export function normalizeAnnounce(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const language of ANNOUNCE_LANGUAGES) {
    const text = typeof value[language] === "string" ? value[language].replace(/\s+/g, " ").trim() : "";
    if (text) out[language] = text.slice(0, ANNOUNCE_MAX_CHARS);
  }
  return out;
}

/**
 * What is wrong with an announcement being saved, as translatable codes (validation:handoff.*).
 * @param {unknown} value
 * @returns {Array<{code: string, vars?: object}>}
 */
export function announceProblems(value) {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return [{ code: "announceInvalid" }];
  const problems = [];
  for (const [language, text] of Object.entries(value)) {
    if (!ANNOUNCE_LANGUAGES.includes(language)) {
      problems.push({ code: "announceInvalid" });
      continue;
    }
    if (text === null || text === undefined || text === "") continue;
    if (typeof text !== "string") {
      problems.push({ code: "announceInvalid" });
      continue;
    }
    if (text.trim().length > ANNOUNCE_MAX_CHARS) problems.push({ code: "announceTooLong", vars: { max: ANNOUNCE_MAX_CHARS } });
    // Anything in braces other than {name} and {role} would be read out to the caller literally.
    const unknown = (text.match(ANY_PLACEHOLDER) ?? []).filter((p) => !ANNOUNCE_PLACEHOLDERS.includes(p));
    if (unknown.length) problems.push({ code: "announcePlaceholder", vars: { value: unknown[0], allowed: ANNOUNCE_PLACEHOLDERS.join(" ") } });
  }
  return problems;
}

/**
 * The line said before the caller is put through to `contact`.
 *
 * @param {object} args
 * @param {{announce?: object}|null} args.escalation  the agent's forwarding settings
 * @param {{name?: string, role?: string}} args.contact
 * @param {"en"|"ur"} args.language                    the agent's reply language
 * @returns {string}
 */
export function announcementFor({ escalation, contact, language }) {
  const l = lang(language);
  const name = String(contact?.name ?? "").trim();
  const role = roleFor(String(contact?.role ?? "").trim(), l);
  const own = normalizeAnnounce(escalation?.announce)[l];
  if (own) {
    return tidy(
      own
        .split("{name}")
        .join(name || (role ? (l === "ur" ? `ہمارے ${role}` : `our ${role}`) : STAND_IN[l].name))
        .split("{role}")
        .join(role || STAND_IN[l].role)
    );
  }
  if (name && role) return tidy(DEFAULT_ANNOUNCE[l].split("{name}").join(name).split("{role}").join(role));
  const who = name || (role ? (l === "ur" ? `ہمارے ${role}` : `our ${role}`) : STAND_IN[l].name);
  return tidy(DEFAULT_ONE_PART[l].split("{who}").join(who));
}

/**
 * The first person did not answer: say so, and announce the next one.
 * "Ali isn't available right now. I'm connecting you to Adan, our Senior. Please stay on the line."
 *
 * @param {object} args
 * @param {{announce?: object}|null} args.escalation
 * @param {{name?: string, role?: string}} args.previous
 * @param {{name?: string, role?: string}} args.contact
 * @param {"en"|"ur"} args.language
 */
export function nextContactLine({ escalation, previous, contact, language }) {
  const l = lang(language);
  const before = String(previous?.name ?? "").trim() || (previous?.role ? (l === "ur" ? `ہمارے ${roleFor(String(previous.role).trim(), l)}` : `Our ${previous.role}`) : l === "ur" ? "وہ" : "That person");
  return `${NOT_ANSWERING[l].split("{previous}").join(before)} ${announcementFor({ escalation, contact, language: l })}`;
}
