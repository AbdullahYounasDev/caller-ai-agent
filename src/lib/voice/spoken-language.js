import { stopWordCounts } from "@/lib/agent/language";

/** Arabic-script letters (Urdu is written in it). */
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
const ANY_LETTER = /\p{L}/gu;

/**
 * WHICH LANGUAGE A SENTENCE IS SPOKEN IN — "en" | "it" | "ur" — and so which voice reads it.
 *
 * When the business fixed a reply language, that is the answer (§7: the business
 * decided). When it is "auto", the MODEL decides the reply's language by mirroring the
 * caller (prompt.js), so the voice has to follow the text it is handed — an Italian or
 * Urdu sentence read by the English voice is unintelligible.
 *
 *   - Urdu is recognised by its SCRIPT: a sentence that is mostly Arabic-script letters
 *     is Urdu. (Arabic itself is not a spoken language of this product; prompt.js tells
 *     the model to write Urdu in Urdu script, never Roman Urdu, for exactly this reason.)
 *   - English vs Italian by stop words: they share almost no function words.
 *   - STICKY: a sentence with no evidence either way ("Pro: 149 euro.") keeps the
 *     previous sentence's voice instead of flipping mid-reply.
 *
 * Pure (tests/voice-units.test.mjs).
 *
 * @param {object} args
 * @param {"en"|"it"|"ur"|"auto"} args.replyLanguage  agent_configs.replyLanguage
 * @param {string} args.text                          the sentence about to be spoken
 * @param {"en"|"it"|"ur"|null} [args.previous]       the language of the last sentence
 * @returns {"en"|"it"|"ur"}
 */
export function chooseSpokenLanguage({ replyLanguage, text, previous = null }) {
  if (replyLanguage === "en" || replyLanguage === "it" || replyLanguage === "ur") return replyLanguage;

  const letters = String(text ?? "").match(ANY_LETTER)?.length ?? 0;
  const arabic = String(text ?? "").match(ARABIC_SCRIPT)?.length ?? 0;
  if (letters && arabic / letters > 0.5) return "ur";

  const { italian, english } = stopWordCounts(text);
  if (italian > english) return "it";
  if (english > italian) return "en";
  return previous ?? "en";
}
