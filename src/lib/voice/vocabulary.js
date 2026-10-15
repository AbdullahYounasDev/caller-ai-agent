import { PLACEHOLDER_BUSINESS_NAME } from "@/lib/tenant/config";

/**
 * NAMES THE SPEECH RECOGNISER CANNOT KNOW — corrected before the brain sees them.
 *
 * A recogniser has never heard of the business. Asked about "Nyron", Parakeet writes
 * "NIRON" even for clean synthetic speech, and a real caller came out as "Nairan",
 * "Niron" and "Nairawan" in one call. Every later step then works on the wrong word: the
 * search embeds "Nairan" and finds nothing, the empty result triggers a rewrite and a
 * second search (≈1–1.5 s more), and the model — handed "tell me about Niron" — says it
 * has no information. Measured on that call: 4 of 5 turns answered "I don't know".
 *
 * The fix is here, in the speech layer, because it is a HEARING problem: the transcript
 * the session hands to respond() should already say what the caller meant. Pure and
 * deterministic — no model call, a few microseconds a turn.
 *
 * HOW A WORD IS MATCHED (all must hold):
 *   - it starts with a capital letter. Recognisers capitalise what they take for a proper
 *     noun ("Nairan", "NIRON"), so an ordinary word ("small", "neuron") is left alone;
 *   - it SOUNDS the same: the same first letter and the same consonant skeleton once
 *     vowels and the soft letters y/w/h are dropped (Nyron, Niron, Nairan, Nairawan → n-r-n);
 *   - at the start of a sentence, where every word is capitalised, it must also be within
 *     one letter of the name — "Small" must not become "Smile".
 * A name word with fewer than three consonant sounds is never used: too many real words
 * share a two-consonant skeleton.
 *
 * Today the vocabulary is the business's own name. Product names are the obvious next
 * entries (a "key terms" setting, or names mined from the knowledge base); the matcher
 * does not change.
 */

/** Latin-script words only: an Urdu transcript is never touched. */
const WORD = /[A-Za-z][A-Za-z'’]*/g;
const MIN_SKELETON = 3;

/**
 * The words of this business that a recogniser is likely to mangle.
 * @param {{businessName?: string}} config
 * @returns {string[]}
 */
export function callVocabulary(config) {
  const name = config?.businessName?.trim();
  if (!name || name === PLACEHOLDER_BUSINESS_NAME) return [];
  const words = name.match(WORD) ?? [];
  return [...new Set(words.filter((w) => soundKey(w).length >= MIN_SKELETON))];
}

/**
 * Replace sound-alikes of vocabulary words with the real spelling.
 * @param {string} text  a transcript
 * @param {string[]} vocabulary
 * @returns {{text: string, corrections: string[]}}  corrections as "heard→meant"
 */
export function correctTranscript(text, vocabulary) {
  if (!text || !vocabulary?.length) return { text, corrections: [] };
  const terms = vocabulary.map((term) => ({ term, key: soundKey(term), lower: term.toLowerCase() }));
  const corrections = [];

  const corrected = text.replace(WORD, (word, offset) => {
    if (!/^[A-Z]/.test(word)) return word;
    const lower = word.toLowerCase();
    const key = soundKey(word);
    const before = text.slice(0, offset).trimEnd();
    const startsSentence = before === "" || /[.!?]$/.test(before);
    for (const { term, key: termKey, lower: termLower } of terms) {
      if (lower === termLower) return word === term ? word : term;
      if (key !== termKey) continue;
      if (startsSentence && editDistance(lower, termLower) > 1) continue;
      corrections.push(`${word}→${term}`);
      return term;
    }
    return word;
  });

  return { text: corrected, corrections };
}

/**
 * What a word sounds like, roughly: first letter + consonant skeleton. English spelling
 * collapsed just enough that the ways a recogniser spells an unknown name meet.
 * Exported for tests.
 */
export function soundKey(word) {
  const w = String(word)
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s");
  if (!w) return "";
  const rest = w.slice(1).replace(/[aeiouyhw]/g, "");
  const head = /[aeiou]/.test(w[0]) ? "a" : w[0];
  return (head + rest).replace(/(.)\1+/g, "$1");
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}
