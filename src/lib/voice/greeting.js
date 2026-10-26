import { voiceFor } from "./speech/voices";
import { mentionsNotice } from "@/lib/phrases";

/**
 * THE CALL'S OPENING LINE — what each agent says the moment a call connects (CLAUDE.md §6.24).
 *
 * Pure, no I/O: used by prompt.js buildVoiceGreeting (what the call says), by PUT /api/agent-config
 * (what may be saved) and by the console (the live preview and the warnings), so the three can
 * never disagree. It lives here rather than in prompt.js because the console shows it as the
 * owner types, and prompt.js cannot be loaded in a browser.
 *
 * PER AGENT, two settings (agent_configs.greeting, agent_configs.record_calls):
 *   greeting     { en?: string, ur?: string } — the owner's own words per spoken language. Empty or
 *                left out = the BUILT-IN greeting below. "{business}" is replaced by the business name.
 *   recordCalls  the owner switched call recording on.
 *
 * THE BUILT-IN GREETING says the caller is speaking with an AI assistant — required in the UK and
 * Ireland (and the EU), good practice everywhere — and, ONLY while recording is on, that the call is
 * recorded. With recording off it never mentions recording: it must not say something untrue.
 *
 * THE OWNER'S OWN GREETING is spoken exactly as written. Pakistan is the first market and its
 * owners decide; nothing is added behind their back. What they get instead is a WARNING in the
 * console (greetingNotices) when their text drops the AI notice, drops the recording notice while
 * recording is on, or mentions recording while it is off — with the reason (the UK and Ireland
 * require telling callers; recording law asks for it too).
 */

export const GREETING_LANGUAGES = ["en", "ur"];
export const MAX_GREETING_CHARS = 400;
export const BUSINESS_PLACEHOLDER = "{business}";

const PLACEHOLDER_ANY = /\{[^{}]*\}/g;

/**
 * The built-in greeting. Voice-safe: no digits, markdown or URLs, and it ends on a question so the
 * caller knows it is their turn. In Urdu the closing verb agrees with the voice's gender
 * ("سکتی" / "سکتا"), like everything the agent says after it; "AI" is written in Urdu script
 * ("اے آئی") so the Urdu voice reads it instead of spelling Latin letters.
 *
 * @param {{language: "en"|"ur", businessName?: string|null, recordCalls?: boolean, gender?: "female"|"male"}} args
 * @returns {string}
 */
export function defaultGreeting({ language, businessName = null, recordCalls = false, gender = "female" }) {
  const name = businessName?.trim() || null;
  if (language === "ur") {
    const can = gender === "female" ? "سکتی" : "سکتا";
    return (
      `السلام علیکم، ${name ? `${name} کو ` : ""}کال کرنے کا شکریہ۔ ` +
      `آپ ایک اے آئی اسسٹنٹ سے بات کر رہے ہیں${recordCalls ? "، اور یہ کال ریکارڈ کی جا رہی ہے" : ""}۔ ` +
      `میں آپ کی کیا مدد کر ${can} ہوں؟`
    );
  }
  return (
    `Hello, thanks for calling${name ? ` ${name}` : ""}. ` +
    `You're speaking with an AI assistant${recordCalls ? ", and this call is being recorded" : ""}. ` +
    "How can I help you today?"
  );
}

/**
 * The owner's text with "{business}" filled in. With no business name the placeholder is dropped
 * and the spacing and punctuation around it tidied ("thanks for calling {business}." → "thanks for
 * calling.").
 * @param {string} text
 * @param {string|null} businessName
 */
export function fillGreeting(text, businessName) {
  const name = businessName?.trim() || "";
  return String(text ?? "")
    .split(BUSINESS_PLACEHOLDER)
    .join(name)
    .replace(/\s+([,.!?،۔؟])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * A stored greeting in its clean form: only known languages, trimmed, empty ones dropped. Reading
 * never throws — a call is waiting.
 * @param {unknown} value
 * @returns {{en?: string, ur?: string}}
 */
export function normalizeGreeting(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const language of GREETING_LANGUAGES) {
    const text = typeof value[language] === "string" ? value[language].trim().replace(/[ \t]+/g, " ") : "";
    if (text) out[language] = text.slice(0, MAX_GREETING_CHARS);
  }
  return out;
}

/**
 * What is wrong with a greeting being saved. Refusals only — the notices (missing AI notice…) are
 * warnings, never refusals: the owner decides.
 * @param {unknown} value
 * @returns {Array<{code: "invalid"|"unknownLanguage"|"tooLong"|"unknownPlaceholder", vars?: object}>}
 */
export function greetingProblems(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{ code: "invalid" }];
  const problems = [];
  for (const [language, text] of Object.entries(value)) {
    if (!GREETING_LANGUAGES.includes(language)) {
      problems.push({ code: "unknownLanguage", vars: { value: language } });
      continue;
    }
    if (text === null || text === undefined) continue;
    if (typeof text !== "string") {
      problems.push({ code: "invalid" });
      continue;
    }
    if (text.trim().length > MAX_GREETING_CHARS) problems.push({ code: "tooLong", vars: { max: MAX_GREETING_CHARS } });
    // Only {business}: anything else in braces would be read out to the caller literally.
    const unknown = (text.match(PLACEHOLDER_ANY) ?? []).filter((p) => p !== BUSINESS_PLACEHOLDER);
    if (unknown.length) problems.push({ code: "unknownPlaceholder", vars: { value: unknown[0], allowed: BUSINESS_PLACEHOLDER } });
  }
  return problems;
}

/**
 * What the agent will say when a call connects.
 *
 * @param {object} config from getAgentConfig() — replyLanguage, businessName (a placeholder name
 *   must already be null/empty), greeting, recordCalls, voices
 * @param {{businessName?: string|null}} [override]
 * @returns {{text: string, language: "en"|"ur", custom: boolean}}
 */
export function buildGreeting(config, { businessName = config?.businessName ?? null } = {}) {
  const language = config?.replyLanguage === "ur" ? "ur" : "en";
  const own = normalizeGreeting(config?.greeting)[language];
  if (own) return { text: fillGreeting(own, businessName), language, custom: true };
  return {
    text: defaultGreeting({
      language,
      businessName,
      recordCalls: Boolean(config?.recordCalls),
      gender: voiceFor(config?.voices, language).gender,
    }),
    language,
    custom: false,
  };
}

/**
 * The console's warnings about an OWNER-WRITTEN greeting (the built-in one needs none). Each is a
 * translation key under dashboard:greeting.notice.* — the owner reads why, and decides.
 *
 *   noAiNotice              it never says the caller is speaking with an AI
 *   noRecordingNotice       recording is on and it never says so
 *   recordingWhileOff       it says the call is recorded, and recording is off
 *
 * @param {{text: string, recordCalls: boolean}} args
 * @returns {Array<"noAiNotice"|"noRecordingNotice"|"recordingWhileOff">}
 */
export function greetingNotices({ text, recordCalls }) {
  const own = String(text ?? "").trim();
  if (!own) return [];
  const notices = [];
  if (!mentionsNotice(own, "ai")) notices.push("noAiNotice");
  const saysRecorded = mentionsNotice(own, "recording");
  if (recordCalls && !saysRecorded) notices.push("noRecordingNotice");
  if (!recordCalls && saysRecorded) notices.push("recordingWhileOff");
  return notices;
}
