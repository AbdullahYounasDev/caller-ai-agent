/**
 * The keyword half's QUERY — what retrieve.js asks Postgres full-text search for.
 *
 * `plainto_tsquery` ANDs every word. A sentence-length question ("How many
 * practitioners can the ClinicHMS Growth plan support?") then demands a chunk that
 * contains ALL of its words, and a real chunk never does, so the keyword score is
 * zero and the hybrid ranking is just the vector ranking (§6.3). This builds the
 * alternative: the question's CONTENT words, joined with `|` (OR), so a chunk is
 * scored on how many of them it has and how close together they sit.
 *
 * Pure and dependency-free so it can be unit-tested and used by the offline
 * keyword eval (scripts/eval-keyword.mjs) without a database or a model.
 *
 * Why a stop-word list of our own when Postgres configs already drop stop words:
 * the query is analysed with EACH CHUNK's config (§6.3). An Italian question run
 * through the `english` config keeps "quanto", "della", "vostra" as terms; and with
 * OR a single junk term that happens to occur in a chunk now adds score instead of
 * being harmlessly ANDed away. So the filter is the UNION of both active languages
 * (§7) plus question words and chat filler ("tell me about", "you guys").
 *
 * SAFE TO INTERPOLATE INTO to_tsquery(): every term is letters/digits only, so a
 * caller cannot smuggle tsquery operators (& | ! <-> ( ) :*) in through a question.
 */

const STOPWORDS = new Set(
  (
    // English: function words, auxiliaries, question words, chat filler.
    "a an the and or but if then than so of to in on at by for from with without about into over under up out off as is are was were be been being am do does did done doing have has had having will would can could should may might must shall " +
    "i me my mine we us our ours you your yours he him his she her hers it its they them their theirs this that these those there here " +
    "what whats which who whom whose when where why how much many more most some any each other such no not nor only own same too very just also " +
    "tell give show let get got please guys guy thing things stuff want need like know ok okay yes hi hello hey thanks thank " +
    // English contraction fragments left behind by splitting on the apostrophe.
    "s t re ve ll d m don doesn didn isn aren wasn weren won wouldn couldn shouldn can cant " +
    // Italian: articles, prepositions, pronouns, auxiliaries, question words, filler.
    "il lo la i gli le un uno una di del dello della dei degli delle da dal dalla dai dalle al allo alla ai agli alle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle " +
    "per con su tra fra e ed o ma se non che chi cui come quando dove perché perche anche più piu molto " +
    "è sono siamo siete hanno ha abbiamo avete ho hai essere avere stato stata sia siano " +
    "questo questa questi queste quello quella quelli quelle nostro nostra nostri nostre vostro vostra vostri vostre suo sua suoi sue loro ci vi mi ti si già solo ogni tutti tutte tutto " +
    "quanto quanta quanti quante quale quali qual cosa fare posso può possiamo puoi vorrei volevo dimmi dammi " +
    // Italian elisions left behind by splitting on the apostrophe (l'azienda, dell'ordine, quest'anno).
    "l dell all nell sull quest quell dov com anch c un po"
  ).split(/\s+/)
);

/** More than this many terms stops adding signal and starts adding cost. */
const MAX_TERMS = 12;

/**
 * @param {string} question the customer's (possibly rewritten) message
 * @returns {{terms: string[], tsquery: string}} `tsquery` is "" when nothing but
 *   filler remained — the caller must then fall back to the AND query rather than
 *   hand Postgres an empty one.
 */
export function buildKeywordQuery(question) {
  const seen = new Set();
  const terms = [];
  // Split on anything that is not a letter or digit — apostrophes and hyphens
  // included, so "what's" -> "what","s" and "l'azienda" -> "l","azienda".
  for (const raw of String(question ?? "").normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    // A lone letter is never a useful search term; a lone digit can be ("plan 5").
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= MAX_TERMS) break;
  }
  return { terms, tsquery: terms.join(" | ") };
}

/** Exposed so a test can pin the list's two promises: filler is in, content words are not. */
export const KEYWORD_STOPWORDS = STOPWORDS;
