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
 * The WHOLE business name, when it holds a word too short to be corrected on its own ("KO Restaurants": "KO" has one
 * consonant sound, so the vocabulary above rightly leaves it out) next to a long one. Real calls heard it as "Kew
 * restaurants" and "Cave Resturants". The recogniser gets it as its spelling prompt, and correctTranscript can put a
 * sound-alike of the short word right: the long word beside it is the anchor that makes that safe. Null otherwise.
 * @param {{businessName?: string}} config
 * @returns {string|null}
 */
export function callPhrase(config) {
  const name = config?.businessName?.trim();
  if (!name || name === PLACEHOLDER_BUSINESS_NAME) return null;
  const words = name.match(WORD) ?? [];
  const short = words.some((w) => soundKey(w).length < MIN_SKELETON);
  const long = words.some((w) => soundKey(w).length >= MIN_SKELETON);
  return short && long ? words.join(" ") : null;
}

/** A word that can stand in for a short name word: capitalised (a recogniser capitalises what it takes for a name), at most
 *  five letters, the same first sound and no more than one extra consonant sound. "Kew", "Cave", "Cow" for "KO". */
function standsInForShortWord(candidate, shortWord) {
  if (!/^[A-Z]/.test(candidate) || candidate.length > 5) return false;
  const a = soundKey(candidate);
  const b = soundKey(shortWord);
  return a[0] === b[0] && a.length <= b.length + 1;
}

/**
 * "Kew restaurants" → "KO Restaurants": the phrase's long words are found by sound (anywhere in the case they came in),
 * and the capitalised word right before (or after) one of them takes the short word's place. Only ever next to a long
 * word of the name: a lone "Kew" or "cow" is left alone.
 */
function correctPhrase(text, phrase, corrections) {
  const words = phrase.match(WORD) ?? [];
  const tokens = [...text.matchAll(WORD)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
  const adjacent = (a, b) => /^\s+$/.test(text.slice(tokens[a].end, tokens[b].start));
  const out = [];
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let fits = true;
    for (let k = 0; k < words.length && fits; k++) {
      const token = tokens[i + k];
      if (k > 0 && !adjacent(i + k - 1, i + k)) fits = false;
      else if (soundKey(words[k]).length >= MIN_SKELETON) fits = soundKey(token.word) === soundKey(words[k]);
      else if (token.word === words[k]) fits = true;
      else if (!standsInForShortWord(token.word, words[k])) fits = false;
    }
    if (!fits) continue;
    const heard = text.slice(tokens[i].start, tokens[i + words.length - 1].end);
    if (heard === phrase) continue;
    // The right words in another case are not a mishearing: nothing to put right.
    if (heard.toLowerCase() === phrase.toLowerCase()) continue;
    out.push({ start: tokens[i].start, end: tokens[i + words.length - 1].end, heard });
    i += words.length - 1;
  }
  let result = text;
  for (const { start, end, heard } of out.reverse()) {
    corrections.unshift(`${heard}→${phrase}`);
    result = result.slice(0, start) + phrase + result.slice(end);
  }
  return result;
}

/**
 * Replace sound-alikes of vocabulary words with the real spelling.
 * @param {string} text  a transcript
 * @param {string[]} vocabulary
 * @param {{phrase?: string|null}} [options]  the whole business name (callPhrase)
 * @returns {{text: string, corrections: string[]}}  corrections as "heard→meant"
 */
export function correctTranscript(text, vocabulary, { phrase = null } = {}) {
  if (!text || (!vocabulary?.length && !phrase)) return { text, corrections: [] };
  const corrections = [];
  if (phrase) text = correctPhrase(text, phrase, corrections);
  if (!vocabulary?.length) return { text, corrections };
  const terms = vocabulary.map((term) => ({ term, key: soundKey(term), lower: term.toLowerCase() }));

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
