import * as en from "./en";
import * as ur from "./ur";
import * as romanUr from "./roman-ur";

/**
 * GENERIC OPENERS — "who are you?", "tell me about your company", "aap kya karte hain?",
 * "آپ کی سروسز کیا ہیں؟" — recognised by rules, with no model call (CLAUDE.md §6.20).
 *
 * The WORDS live in one file per way of writing, so they can be read and extended by someone who
 * speaks that language without touching code: ./en.js (English), ./ur.js (Urdu script),
 * ./roman-ur.js (Urdu in English letters). This file only matches them. Pure, no I/O: imported by
 * the brain (query.js, prompt.js, handoff) and by the console (the greeting notices).
 *
 * WHY RULES: an opener is the first thing said on most calls, when latency is most noticeable,
 * and it needs no understanding beyond "this is about the business as a whole" — a pattern
 * does that perfectly well and costs nothing (the same reasoning as intent.js).
 *
 * WHAT COUNTS: a phrase from a group must appear, AND the rest of the message must be filler
 * (FILLER in each file, plus the business's own name). "Hi, could you please tell me a bit about
 * your company?" is an opener; "tell me about your refund policy" is not (no phrase matches);
 * "who is this plan for?" is not ("plan" is left over). The overview groups (`about`,
 * `offerings`) allow ONE leftover word — "what services do you offer for kids" is still mostly
 * an overview — the others none.
 */

/** @typedef {"identity"|"about"|"offerings"|"help"|"aiCheck"} OpenerKind */

export const OPENER_KINDS = /** @type {OpenerKind[]} */ (["identity", "about", "offerings", "help", "aiCheck"]);
/** The groups about the BUSINESS, which the business-name search and the profile answer. */
export const OVERVIEW_KINDS = new Set(["identity", "about", "offerings", "help"]);
const LEFTOVER_ALLOWED = { identity: 0, about: 1, offerings: 1, help: 0, aiCheck: 0 };
const MAX_WORDS = 24;
const MAX_GAP = 3;

// ── normalising text ───────────────────────────────────────────────────────

const CONTRACTIONS = [
  [/\bwhat's\b/g, "what is"], [/\bwho's\b/g, "who is"], [/\bit's\b/g, "it is"], [/\bthat's\b/g, "that is"],
  [/\bwhere's\b/g, "where is"], [/\bhow's\b/g, "how is"], [/\bthere's\b/g, "there is"],
  [/\byou're\b/g, "you are"], [/\bwe're\b/g, "we are"], [/\bthey're\b/g, "they are"], [/\bi'm\b/g, "i am"],
  [/\byou've\b/g, "you have"], [/\bi've\b/g, "i have"], [/\bi'd\b/g, "i would"], [/\byou'd\b/g, "you would"],
  [/\bcan't\b/g, "can not"], [/\bdon't\b/g, "do not"], [/\bdoesn't\b/g, "does not"], [/\bisn't\b/g, "is not"],
  [/\baren't\b/g, "are not"], [/\bwon't\b/g, "will not"], [/\bi'll\b/g, "i will"], [/\blet's\b/g, "let us"],
];

/**
 * Lower case, contractions expanded, Urdu diacritics removed and Arabic letter forms folded into
 * the Urdu ones, punctuation (Latin and Urdu) turned into spaces.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  let s = String(text ?? "").normalize("NFC").toLowerCase().replace(/[’‘`´]/g, "'");
  for (const [re, long] of CONTRACTIONS) s = s.replace(re, long);
  s = s
    .replace(/[ً-ٰٟۖ-ۭـ]/g, "") // harakat, small marks, tatweel
    .replace(/[​-‏﻿]/g, "") // zero-width (non-)joiners and marks
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ةۃ]/g, "ہ")
    .replace(/ه(?=$|[^\p{L}])/gu, "ہ")
    .replace(/ه/g, "ہ")
    .replace(/أ|إ/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

const tokensOf = (text) => normalizeText(text).split(" ").filter(Boolean);

// ── Roman Urdu spelling ────────────────────────────────────────────────────

const ROMAN_VARIANT = new Map();
const ROMAN_MULTIWORD = [];
for (const [canonical, variants] of Object.entries(romanUr.SPELLINGS)) {
  for (const variant of variants) {
    const v = normalizeText(variant);
    if (v.includes(" ")) ROMAN_MULTIWORD.push([new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "gu"), canonical]);
    else if (v !== canonical) ROMAN_VARIANT.set(v, canonical);
  }
}

function romanTokens(text) {
  let s = normalizeText(text);
  for (const [re, canonical] of ROMAN_MULTIWORD) s = s.replace(re, canonical);
  return s.split(" ").filter(Boolean).map((w) => ROMAN_VARIANT.get(w) ?? w);
}

// ── compiling phrases ──────────────────────────────────────────────────────

/**
 * A phrase becomes a list of steps:
 *   { alts: Set, optional }  one word out of `alts`; "a/b" lists alternatives, a trailing "?" makes it optional
 *   { gap: true }            "*": one to MAX_GAP words
 *   { name: true }           "{name}": the business's own name, word for word
 */
function compile(phrase, canonicalise) {
  const steps = [];
  for (const raw of phrase.trim().split(/\s+/)) {
    if (raw === "*") steps.push({ gap: true });
    else if (raw === "{name}") steps.push({ name: true });
    else {
      const optional = raw.endsWith("?");
      const body = optional ? raw.slice(0, -1) : raw;
      const alts = new Set(
        body
          .split("/")
          .map((w) => normalizeText(w))
          .filter(Boolean)
          .map(canonicalise)
      );
      steps.push({ alts, optional });
    }
  }
  return steps;
}

const identity = (w) => w;
const LANGUAGES = [
  { id: "en", tokens: tokensOf, canonicalise: identity, data: en },
  { id: "ur", tokens: tokensOf, canonicalise: identity, data: ur },
  { id: "roman-ur", tokens: romanTokens, canonicalise: (w) => ROMAN_VARIANT.get(w) ?? w, data: romanUr },
];
for (const language of LANGUAGES) {
  language.groups = OPENER_KINDS.map((kind) => ({
    kind,
    phrases: (language.data.OPENERS[kind] ?? []).map((phrase) => compile(phrase, language.canonicalise)),
  }));
  language.filler = new Set(language.data.FILLER.map((w) => language.canonicalise(normalizeText(w))));
}

/**
 * How many words of the business's name start at tokens[at]: the whole name, or the start of it —
 * callers shorten "Nyron Software Solutions" to "Nyron". A one-word start must be 3+ letters.
 * @returns {number} 0 when the name is not there
 */
function nameAt(tokens, at, nameTokens) {
  let n = 0;
  while (n < nameTokens.length && at + n < tokens.length && tokens[at + n] === nameTokens[n]) n++;
  if (n === 1 && nameTokens[0].length < 3) return 0;
  return n;
}

/**
 * Match compiled steps against tokens starting at `start`. Returns the indices of the tokens the
 * phrase used (gap words included), or null.
 */
function matchAt(steps, tokens, start, nameTokens) {
  const used = [];
  const go = (si, ti) => {
    if (si === steps.length) return true;
    const step = steps[si];
    if (step.gap) {
      for (let n = 1; n <= MAX_GAP && ti + n <= tokens.length; n++) {
        for (let k = 0; k < n; k++) used.push(ti + k);
        if (go(si + 1, ti + n)) return true;
        used.length -= n;
      }
      return false;
    }
    if (step.name) {
      const n = nameAt(tokens, ti, nameTokens);
      if (!n) return false;
      for (let k = 0; k < n; k++) used.push(ti + k);
      if (go(si + 1, ti + n)) return true;
      used.length -= n;
      return false;
    }
    if (ti < tokens.length && step.alts.has(tokens[ti])) {
      used.push(ti);
      if (go(si + 1, ti + 1)) return true;
      used.pop();
    }
    return step.optional ? go(si + 1, ti) : false;
  };
  return go(0, start) ? used : null;
}

/**
 * Is this message a generic opener — a question about the business (or the agent) as a whole?
 *
 * @param {string} message
 * @param {{businessName?: string}} [context] the business's name: "what does Pizza Roma do" is an
 *   opener, and the name is never counted as a leftover word
 * @returns {{kind: OpenerKind, language: "en"|"ur"|"roman-ur", phrase: string} | null}
 */
export function detectOpener(message, { businessName = "" } = {}) {
  const text = String(message ?? "");
  if (!text.trim()) return null;
  for (const language of LANGUAGES) {
    const tokens = language.tokens(text);
    if (!tokens.length || tokens.length > MAX_WORDS) continue;
    const nameTokens = language.tokens(businessName);
    // Words that are the business's name ("Pizza Roma", or just "Pizza") are never leftovers. Only
    // the name as it is said counts, not its words one by one: "your clinic software" is not
    // "Nyron Software Solutions".
    const nameIdx = new Set();
    for (let i = 0; i < tokens.length; i++) {
      const n = nameAt(tokens, i, nameTokens);
      for (let k = 0; k < n; k++) nameIdx.add(i + k);
    }
    for (const group of language.groups) {
      for (let p = 0; p < group.phrases.length; p++) {
        const steps = group.phrases[p];
        for (let start = 0; start < tokens.length; start++) {
          const used = matchAt(steps, tokens, start, nameTokens);
          if (!used) continue;
          const taken = new Set(used);
          const leftover = tokens.filter((w, i) => !taken.has(i) && !language.filler.has(w) && !nameIdx.has(i) && !/^\d+$/.test(w) && w.length > 1);
          if (leftover.length <= LEFTOVER_ALLOWED[group.kind]) {
            return { kind: group.kind, language: language.id, phrase: language.data.OPENERS[group.kind][p] };
          }
        }
      }
    }
  }
  return null;
}

/**
 * A question about the business as a whole (who / what / what you offer / how you can help) —
 * the ones the business PROFILE answers and the business-name search helps.
 * @param {string} message
 * @param {{businessName?: string}} [context]
 */
export function isOverviewQuestion(message, context) {
  const found = detectOpener(message, context);
  return Boolean(found && OVERVIEW_KINDS.has(found.kind));
}

/**
 * Does a text (a greeting the owner wrote) say one of the notice words?
 * @param {string} text
 * @param {"ai"|"recording"} notice
 * @returns {boolean}
 */
export function mentionsNotice(text, notice) {
  const plain = ` ${normalizeText(text)} `;
  const roman = ` ${romanTokens(text).join(" ")} `;
  for (const language of LANGUAGES) {
    for (const word of language.data.NOTICE_WORDS[notice] ?? []) {
      const needle = normalizeText(word);
      if (!needle) continue;
      // Latin words on word edges ("ai" must not match "said"); Urdu ones as written, because Urdu
      // runs suffixes on ("ریکارڈنگ", "ریکارڈڈ").
      const latin = /^[a-z0-9 ]+$/.test(needle);
      if (latin ? plain.includes(` ${needle} `) || roman.includes(` ${needle} `) : plain.includes(needle)) return true;
    }
  }
  return false;
}
