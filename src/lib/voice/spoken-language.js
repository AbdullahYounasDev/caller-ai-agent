/** Arabic-script letters (Urdu is written in it). */
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
const LATIN_LETTER = /[A-Za-z]/g;

/**
 * WHICH LANGUAGE A SENTENCE IS SPOKEN IN — "en" | "ur" — and so which voice reads it.
 *
 * The business fixed a reply language (§7: the business decided) and the model is told
 * to answer in it, so that is the answer — with ONE exception that matters in Pakistan:
 * Urdu answers carry English words. prompt.js asks the model to write everyday loanwords
 * in Urdu script, so that is rare; but a brand, a code or an English phrase can still
 * arrive as a sentence with Latin letters and no Urdu letters at all. The Urdu voice
 * would spell that out as gibberish, so an Urdu call speaks such a sentence with the
 * English voice. A sentence with no letters at all ("500.") keeps the language of the
 * sentence before it.
 *
 * Pure (tests/voice-units.test.mjs).
 *
 * @param {object} args
 * @param {"en"|"ur"} args.replyLanguage  agent_configs.replyLanguage
 * @param {string} args.text              the sentence about to be spoken
 * @param {"en"|"ur"|null} [args.previous] the language of the last sentence
 * @returns {"en"|"ur"}
 */
export function chooseSpokenLanguage({ replyLanguage, text, previous = null }) {
  if (replyLanguage !== "ur") return "en";

  const value = String(text ?? "");
  const arabic = value.match(ARABIC_SCRIPT)?.length ?? 0;
  const latin = value.match(LATIN_LETTER)?.length ?? 0;
  if (arabic > 0) return "ur";
  if (latin > 0) return "en";
  return previous ?? "ur";
}
