/**
 * Which Postgres full-text-search CONFIG should a document's chunks be indexed
 * with? (§6.3 — the keyword half of the hybrid ranking.)
 *
 * The keyword rank used to be `to_tsvector('english', …)` for everything. For an
 * Italian document that stems nothing correctly and treats Italian stop words
 * ("il", "per", "della") as content, so the keyword half was nearly noise — for a
 * language the product explicitly supports (§7).
 *
 * Decided per DOCUMENT, not per chunk. A chunk is a few hundred characters of a
 * price table or one policy paragraph — too little text to tell languages apart,
 * and a document is written in one language. Every chunk of it inherits the answer.
 *
 * No dependency: a stop-word count is enough to separate the two ACTIVE locales
 * (English, Italian), and it fails in the direction that keeps today's behaviour:
 *   - clear Italian evidence        → 'italian'
 *   - mostly non-Latin script       → 'simple'  (the dormant ar/ur — no stemmer exists for
 *                                      them in Postgres, and 'english' would shred them)
 *   - anything else, incl. unsure   → 'english' (what every document used before this)
 * 'simple' (no stemming, no stop words) is NOT the unsure-fallback on purpose: a CSV
 * price table has almost no prose, and it ranked fine under 'english'.
 */

const ITALIAN = new Set(
  "il lo la i gli le un uno una di del dello della dei degli delle da dal dalla dai al allo alla ai agli alle nel nello nella nei negli nelle sul sulla per con su tra fra e ed o ma se non che chi cui come quando dove anche più molto è sono siamo siete hanno ha abbiamo avete essere avere questo questa questi queste quello quella nostro nostra nostri nostre vostro vostra suo sua loro ci vi mi ti si già solo ogni tutti tutte tutto".split(" ")
);
const ENGLISH = new Set(
  "the of and to in is are was were be been a an that this these those it its for on with as at by from or not but if than then so we you your our their they he she his her have has had do does did will would can could should may might which who whom what when where how all any each more most other some such no nor only own same too very just also into over under about up out".split(" ")
);

/** Below this many stop words in the sample there is nothing to judge by. */
const MIN_EVIDENCE = 8;
/** How much more Italian than English evidence counts as "clearly Italian". */
const ITALIAN_RATIO = 1.5;
const SAMPLE_CHARS = 6000;

/**
 * @param {string} text the document's full text
 * @returns {"english"|"italian"|"simple"}
 */
export function detectSearchConfig(text) {
  const sample = String(text ?? "").slice(0, SAMPLE_CHARS);

  const letters = sample.match(/\p{L}/gu) ?? [];
  const latin = sample.match(/[A-Za-zÀ-ÿ]/g) ?? [];
  if (letters.length >= 40 && latin.length / letters.length < 0.5) return "simple";

  const { italian, english } = stopWordCounts(sample);
  // "e", "a", "i", "la", "me"… exist in both lists' neighbours; the ratio, not the
  // raw count, is what separates them.
  if (italian >= MIN_EVIDENCE && italian >= english * ITALIAN_RATIO) return "italian";
  return "english";
}

/**
 * The raw evidence detectSearchConfig judges by: how many English and Italian stop
 * words the text contains. Exported for callers with a different question and a
 * different threshold — the voice gateway picks which VOICE speaks a reply from one
 * spoken sentence, far below MIN_EVIDENCE (src/lib/voice/spoken-language.js).
 *
 * @param {string} text
 * @returns {{italian: number, english: number}}
 */
export function stopWordCounts(text) {
  let italian = 0;
  let english = 0;
  for (const word of String(text ?? "").toLowerCase().match(/[a-zà-ÿ]+/g) ?? []) {
    if (ITALIAN.has(word)) italian++;
    if (ENGLISH.has(word)) english++;
  }
  return { italian, english };
}

/** The configs a chunk may carry. retrieve.js builds one tsquery per entry. */
export const SEARCH_CONFIGS = ["english", "italian", "simple"];
