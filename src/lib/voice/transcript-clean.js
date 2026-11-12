/**
 * TWO SMALL REPAIRS OF WHAT THE RECOGNISER HEARD — pure, no I/O (tests/voice-continuation.test.mjs).
 *
 * 1. `collapseRepeats` — Whisper sometimes writes the same phrase twice in a row from a
 *    single utterance ("Yes, book it now. Yes, book it now."). The doubled text is sent to
 *    the model and shown in the transcript, and a repeated phrase reads as the caller
 *    insisting. Only a repeat of THREE words or more is collapsed: "no, no, no" and "very
 *    very good" are things people really say.
 *
 * 2. `looksUnfinished` — did the transcript stop in the middle of a thought? A caller who
 *    pauses mid-sentence ("I want to book an appointment… with Doctor Ayesha") used to be
 *    answered twice, once for each half. A transcript that ends on a joining word or a
 *    comma is held for a moment (session.js) to see whether the rest follows.
 *
 * 3. `unreadableScript` — did the recogniser write the call in a script nobody speaks to this agent? It is not told which
 *    language it is hearing (stt.js), and on a short or clipped utterance it sometimes picks one at random: "No, nothing"
 *    came back in Cyrillic on a real call. That is not a question for the documents; it is speech we could not read.
 *
 * English, Urdu script and Roman Urdu — the way callers actually speak. JavaScript's \b does
 * not see Arabic-script letters, so word edges are Unicode-aware here too (collect/phrases.js).
 */

const normalise = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const MIN_REPEAT_WORDS = 3;

/**
 * "Yes, book it now. Yes, book it now." → "Yes, book it now."
 * Handles a sentence repeated back to back, and a whole utterance written twice with no
 * punctuation between the copies.
 *
 * @param {string} text
 * @returns {{text: string, collapsed: boolean}}
 */
export function collapseRepeats(text) {
  const original = String(text ?? "").trim();
  if (!original) return { text: original, collapsed: false };

  // (a) Whole text = one phrase written 2+ times, with or without punctuation between.
  const tokens = original.split(/\s+/);
  for (let size = MIN_REPEAT_WORDS; size <= Math.floor(tokens.length / 2); size++) {
    if (tokens.length % size !== 0) continue;
    const unit = tokens.slice(0, size);
    const unitKey = normalise(unit.join(" "));
    let same = true;
    for (let i = size; i < tokens.length && same; i += size) {
      same = normalise(tokens.slice(i, i + size).join(" ")) === unitKey;
    }
    if (same) return { text: unit.join(" ").replace(/[,;]+$/, "").trim(), collapsed: true };
  }

  // (b) The same sentence twice (or more) in a row inside a longer text.
  const sentences = original.match(/[^.!?؟۔]+[.!?؟۔]*\s*/gu) ?? [original];
  const kept = [];
  let collapsed = false;
  for (const sentence of sentences) {
    const key = normalise(sentence);
    const previous = kept.length ? normalise(kept[kept.length - 1]) : null;
    if (key && key === previous && key.split(" ").length >= MIN_REPEAT_WORDS) {
      collapsed = true;
      continue;
    }
    kept.push(sentence);
  }
  return { text: collapsed ? kept.join("").trim() : original, collapsed };
}

const EDGE_START = "(?<![\\p{L}\\p{M}])";
const EDGE_END = "(?![\\p{L}\\p{M}])";

// The LAST word of a thought a speaker has clearly not finished.
const JOINING = new RegExp(
  `${EDGE_START}(?:` +
    // English: conjunctions, prepositions, articles, possessives, auxiliaries, "I'd like"
    "and|or|but|so|because|if|that|which|who|when|with|for|to|of|in|on|at|by|from|about|the|a|an|my|your|our|his|her|their|" +
    "i'd|i'll|i'm|like|want|need|maybe|also|" +
    // Urdu script: اور، یا، لیکن، کہ، کے، کا، کی، میں، سے، کو، پر، تو، جو، کیونکہ، بھی، پھر، مجھے، میرا، میری
    "اور|یا|لیکن|مگر|کہ|کے|کا|کی|میں|سے|کو|پر|تو|جو|کیونکہ|بھی|پھر|مجھے|میرا|میری|ساتھ|لیے|لئے|" +
    // Roman Urdu
    "aur|ya|lekin|magar|ke|ka|ki|mein|se|ko|par|to|jo|kyunke|bhi|phir|mujhe|mera|meri|saath|liye" +
    `)${EDGE_END}[\\s.…]*$`,
  "iu"
);

/**
 * @param {string} text
 * @returns {boolean} the transcript stops mid-thought: a trailing comma/dash/ellipsis, or a
 *   joining word as the last word ("…with", "…اور", "…and the")
 */
export function looksUnfinished(text) {
  const value = String(text ?? "").trim();
  if (!value) return false;
  if (/[.!?؟۔]$/.test(value) && !/(?:\.\.\.|…)$/.test(value)) return false;
  if (/[,،;:\-–—]$|(?:\.\.\.|…)$/.test(value)) return true;
  return JOINING.test(value);
}

/** Scripts the product speaks (§7): English and Urdu, plus Devanagari, which stt.js asks the recogniser to redo as Urdu. */
const SPOKEN_SCRIPTS = /[\p{Script=Latin}\p{Script=Arabic}\p{Script=Devanagari}]/u;
/** The scripts a mistaken language guess turns up in, for the log. */
const OTHER_SCRIPTS = ["Cyrillic", "Greek", "Han", "Hiragana", "Katakana", "Hangul", "Hebrew", "Thai", "Armenian", "Georgian", "Bengali", "Tamil", "Telugu", "Gujarati", "Gurmukhi", "Ethiopic", "Khmer", "Lao", "Myanmar", "Sinhala"];

/**
 * The name of the script the transcript is written in when it is not one the callers of this product use — mostly letters
 * of Cyrillic, Greek, Chinese, Korean… — or null when it is readable. Half or more of the letters decide it, so one
 * stray foreign letter inside Urdu or English is left alone. Pure.
 *
 * @param {string} text
 * @returns {string|null} e.g. "Cyrillic", or "other"
 */
export function unreadableScript(text) {
  const letters = String(text ?? "").match(/\p{L}/gu) ?? [];
  if (!letters.length) return null;
  const foreign = letters.filter((ch) => !SPOKEN_SCRIPTS.test(ch));
  if (foreign.length * 2 < letters.length) return null;
  let best = "other";
  let bestCount = 0;
  for (const name of OTHER_SCRIPTS) {
    const re = new RegExp("\\p{Script=" + name + "}", "u");
    const count = foreign.filter((ch) => re.test(ch)).length;
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}
