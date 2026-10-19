/**
 * Which Postgres full-text-search CONFIG should a document's chunks be indexed
 * with? (§6.3 — the keyword half of the hybrid ranking.)
 *
 * The keyword rank used to be `to_tsvector('english', …)` for everything. Urdu
 * text run through the English stemmer is shredded: Postgres has no Urdu
 * dictionary, so the only sane config for it is 'simple' (lower-cased words, no
 * stemming, no stop-word list).
 *
 * Decided per DOCUMENT, not per chunk. A chunk is a few hundred characters of a
 * price table or one policy paragraph — too little text to tell scripts apart
 * reliably, and a document is written in one language. Every chunk of it inherits
 * the answer.
 *
 * No dependency, and it fails in the direction that keeps the original behaviour:
 *   - mostly non-Latin script (Urdu) → 'simple'
 *   - anything else, including "unsure" and Roman Urdu (Latin letters) → 'english'
 * 'simple' is NOT the unsure-fallback on purpose: a CSV price table has almost no
 * prose, and it ranked fine under 'english'.
 *
 * The two active languages are English and Urdu (§7); the full-text half is the
 * weaker of the two retrieval signals for Urdu either way, and the multilingual
 * embedding carries the meaning (§6.3).
 */

/** Below this many letters in the sample there is nothing to judge by. */
const MIN_LETTERS = 40;
const SAMPLE_CHARS = 6000;

/**
 * @param {string} text the document's full text
 * @returns {"english"|"simple"}
 */
export function detectSearchConfig(text) {
  const sample = String(text ?? "").slice(0, SAMPLE_CHARS);

  const letters = sample.match(/\p{L}/gu) ?? [];
  const latin = sample.match(/[A-Za-z]/g) ?? [];
  if (letters.length >= MIN_LETTERS && latin.length / letters.length < 0.5) return "simple";
  return "english";
}

/** The configs a chunk may carry. retrieve.js builds one tsquery per entry. */
export const SEARCH_CONFIGS = ["english", "simple"];
