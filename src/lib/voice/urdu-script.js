/**
 * A STRAY DEVANAGARI LETTER IN AN URDU REPLY — repaired before the Urdu voice sees it.
 *
 * Spoken Urdu and Hindi are one language; written, Urdu is Arabic script and Hindi is Devanagari. The chat model,
 * writing Urdu, occasionally slips one Devanagari letter into a word ("چلاتے" written "چلाتے" — 1 of 30 samples,
 * CLAUDE.md §6.24). It looked harmless, and the measurement says it is not: the Urdu voice's phonemizer treats the
 * letter as another LANGUAGE and says its name. With the clean sentence and the same sentence plus one letter, spoken
 * by `kokoro:hf_alpha` and heard by Whisper (4 of 4 sentences): "چلاتے" → "چے لام ہندیا کارتے بارئیے", "وقت" →
 * "ہندی ورک آفتے" — the word "Hindi" in the middle of a price, and 0.5–1.9 s of extra audio.
 *
 * The fix is the sound the letter stands for, written in Urdu script: a fixed letter-for-letter table, so the voice
 * reads "बता" as "بتا" and a lone "व" as "و". It is approximate for a whole Hindi word (short vowels are left to the
 * reader, as Urdu spelling does), which is the right trade: a close word beats the word "Hindi". Anything that is not
 * Devanagari is untouched, and text without Devanagari comes back as the same string.
 *
 * Applied by speech/tts.js to Urdu voices only. The stored and displayed reply is NOT changed — only what is spoken.
 */

const DEVANAGARI = /[ऀ-ॿ]/;

/** Consonants: Devanagari → Urdu script (the sound, not a spelling authority). */
const CONSONANTS = {
  क: "ک", ख: "کھ", ग: "گ", घ: "گھ", ङ: "ن",
  च: "چ", छ: "چھ", ज: "ج", झ: "جھ", ञ: "ن",
  ट: "ٹ", ठ: "ٹھ", ड: "ڈ", ढ: "ڈھ", ण: "ن",
  त: "ت", थ: "تھ", द: "د", ध: "دھ", न: "ن",
  प: "پ", फ: "ف", ब: "ب", भ: "بھ", म: "م",
  य: "ی", र: "ر", ल: "ل", व: "و", श: "ش", ष: "ش", स: "س", ह: "ہ",
  // letters that already carry their dot (U+0958–U+095F)
  "क़": "ق", "ख़": "خ", "ग़": "غ", "ज़": "ز", "ड़": "ڑ", "ढ़": "ڑھ", "फ़": "ف", "य़": "ی",
};
/** The same letters with a nukta (U+093C) after them. */
const NUKTA = { क: "ق", ख: "خ", ग: "غ", ज: "ز", ड: "ڑ", ढ: "ڑھ", फ: "ف", य: "ی" };

/** Vowel signs that follow a consonant. Short vowels (i, u) are not written in Urdu. */
const SIGNS = {
  "ा": "ا", "ि": "", "ी": "ی", "ु": "", "ू": "و", "ृ": "ر",
  "े": "ے", "ै": "ے", "ो": "و", "ौ": "و", "ॅ": "ے", "ॉ": "و",
  "ं": "ں", "ँ": "ں", "ः": "ہ", "्": "", "़": "", "ऽ": "",
};
/** Vowels standing alone (word-initial). */
const VOWELS = {
  अ: "ا", आ: "آ", इ: "ا", ई: "ای", उ: "ا", ऊ: "او", ऋ: "ر", ए: "اے", ऐ: "اے", ओ: "او", औ: "او", ऑ: "او", ऍ: "اے",
};
const DIGITS = "०१२३४५६७८९";
const URDU_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Does the text hold any Devanagari? */
export function hasDevanagari(text) {
  return DEVANAGARI.test(String(text ?? ""));
}

/**
 * Write every Devanagari letter in Urdu script. Text without Devanagari is returned as it came.
 * @param {string} text
 * @returns {string}
 */
export function devanagariToUrdu(text) {
  const s = String(text ?? "");
  if (!DEVANAGARI.test(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (!DEVANAGARI.test(ch)) {
      out += ch;
    } else if (next === "़" && NUKTA[ch]) {
      out += NUKTA[ch];
      i++;
    } else if (ch in CONSONANTS) {
      out += CONSONANTS[ch];
    } else if (ch in SIGNS) {
      out += SIGNS[ch];
    } else if (ch in VOWELS) {
      out += VOWELS[ch];
    } else if (ch === "।" || ch === "॥") {
      out += "۔";
    } else if (DIGITS.includes(ch)) {
      out += URDU_DIGITS[DIGITS.indexOf(ch)];
    }
    // anything else in the block (om, accents, extended letters) is dropped: it has no sound worth guessing
  }
  return out;
}

/**
 * The text the Urdu voice is given.
 * @param {string} text
 * @returns {string}
 */
export function repairUrduScript(text) {
  return devanagariToUrdu(text);
}
