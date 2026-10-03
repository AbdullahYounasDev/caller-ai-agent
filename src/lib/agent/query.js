import { generateRewrite } from "./llm";
import { CircuitOpenError } from "./breaker";
import { retrieveRelevantChunks } from "./retrieve";
import { buildQueryRewriteInstruction, buildQueryRewriteInput } from "./prompt";

/**
 * CONVERSATION-AWARE RETRIEVAL — what gets SEARCHED for, as opposed to what the
 * customer SAID (§6.19).
 *
 * `respond()` used to retrieve with the raw latest message. "And the Pro one?"
 * has no standalone meaning: embedded alone it lands nowhere near the pricing
 * chunk, so the agent either retrieves nothing and says "I don't know" about a
 * thing it was literally just discussing, or retrieves the wrong chunk. On a
 * phone call most turns after the first are exactly this shape.
 *
 * This lives in the shared brain's retrieval path, not in an adapter (§1): the
 * test chat and a phone call must resolve a follow-up identically.
 *
 * Nothing here touches MAX_DISTANCE or the gate (§6.3). The query changes; what
 * counts as relevant enough to show the model is still decided by distance
 * alone, inside retrieveRelevantChunks.
 *
 * STRATEGIES — measured against eval:real's follow-up category, see §6.19:
 *   raw      the old behaviour: search the message as typed. Kept as the
 *            baseline and as an escape hatch.
 *   concat   cheap: prepend the customer's previous question. No model call.
 *   rewrite  an LLM turns {recent conversation + message} into a standalone
 *            query. One extra model call, only when triggered (see below).
 */
export const DEFAULT_QUERY_STRATEGY = "rewrite";
export const QUERY_STRATEGIES = ["raw", "concat", "rewrite"];

/** At or below this many words a message is treated as too short to stand
 *  alone ("and the Pro one?", "what about Sundays?"). Four, not five: five
 *  would catch ordinary complete questions like "How much is StorePulse Pro?",
 *  which would then pay for a model call on every turn for nothing. */
const SHORT_MESSAGE_WORDS = 4;

/**
 * SPECULATIVE RAW SEARCH — OFF. Start the raw-message retrieval AT THE SAME TIME as the
 * rewrite instead of after it, and use the raw result when the rewrite comes back
 * unchanged, fails, is skipped by the breaker, or does not answer within
 * SPECULATIVE_REWRITE_BUDGET_MS.
 *
 * WHAT IT BUYS, honestly. Sequentially a triggered turn costs  rewrite + search.
 * Speculatively it costs  max(rewrite, raw search) when the raw result is used, and
 * rewrite + search when it is not. So:
 *   - rewrite UNCHANGED / FAILED / SKIPPED / TIMED OUT  → saves one whole search
 *     (an embedding round trip + the SQL, roughly 0.3–0.5s — NOT yet measured on a
 *     real provider) and costs nothing extra: the raw search had to happen anyway;
 *   - rewrite CHANGED the query (every genuine follow-up: all 16 in eval:real) → saves
 *     NOTHING, because the rewritten query still has to be embedded and searched after
 *     the rewrite returns, AND it has spent one extra embedding TEXT that is thrown away.
 * The embedding quota is ~1000 texts a day counted per text (§6.20): on follow-up turns
 * that is 2 texts instead of 1. Fires only on the needsContext() path, never when a
 * message already retrieves fine. Net: a latency win on turns that did not need the
 * rewrite, a pure cost on the turns that did. It is not the latency fix for real
 * follow-ups — a faster rewrite model is (GEMINI_REWRITE_MODEL, llm.js).
 */
export const SPECULATIVE_RAW_SEARCH = false;

/**
 * With speculation on the raw result is already in hand, so the rewrite no longer has to
 * be waited for as long as the 3s default: past this the raw result is used. Shorter
 * means less dead air and more follow-ups answered from their raw (elliptical, ~31%
 * hit@1) search; this value is a guess to be set from a real latency measurement.
 */
export const SPECULATIVE_REWRITE_BUDGET_MS = 1500;

/** How much of the conversation the rewrite sees. The topic and the entities
 *  are all it needs; more is tokens and latency spent re-reading a transcript. */
const REWRITE_CONTEXT_MESSAGES = 6;

/** A hard budget on the rewrite call. It is an OPTIONAL step on the hot path of
 *  a phone call: if the provider is slow or retrying a quota error, the
 *  customer must not wait on it. On timeout the raw message is searched. */
const REWRITE_TIMEOUT_MS = 3000;

/** A search query longer than this is the model answering instead of
 *  rewriting; treat it as a failed rewrite rather than search on prose. */
const MAX_QUERY_CHARS = 300;

// "ok", "thanks", "yes please", "grazie", "va bene" — a turn with nothing to
// search for. Without this, every pleasantry on a call is short enough to
// trigger a model call whose best possible output is the same pleasantry.
const ACK_WORD =
  "ok|okay|yes|yeah|yep|no|nope|sure|thanks|thank you|thx|great|perfect|alright|right|got it|please|bye|goodbye|hello|hi|hey|grazie|ciao|va bene|sì|si|certo|perfetto|benissimo|arrivederci|buongiorno|buonasera|prego|per favore";
const ACKNOWLEDGEMENT = new RegExp(`^\\s*((${ACK_WORD})[\\s.!,]*){1,3}$`, "i");

// A message that opens by continuing the previous one…
const ELLIPSIS_OPENER =
  /^\s*(and|but|also|or|so|then|what about|how about|what if|e|ma|anche|invece|oppure|e se|allora|che dire)\b/i;
// …or points back at something already said. English and Italian only — the
// two active locales (§7). Other languages are caught by the empty-first-pass
// trigger below instead of being half-covered here. Bare "one", "la" and "ci"
// are deliberately NOT listed: they are far too common in complete questions
// ("up to one store", "la fattura") and would fire constantly.
const ANAPHORA =
  /\b(it|its|that|those|these|them|they|that one|this one|the (same|other|first|second|third|last|previous) one|quello|quella|quelli|quelle|lo stesso|la stessa)\b/i;

// The pointers above are safe to fire on at any length. The ones below are NOT: each
// matched complete, standalone questions in eval-questions.mjs and cost a needless model
// call (see scripts/eval-trigger.mjs for the before/after).
//
// "this" is ambiguous. "Is this included?" points back; "what's this new connect thing
// you're building" and "can I use this on more than one shop" introduce their own
// referent. It points back only as a bare pronoun (at the end, or before a verb) or
// before a GENERIC noun ("this plan", "this option").
const THIS_POINTS_BACK =
  /\b(this|questo|questa|questi|queste)\s*[?.!]*\s*$|\b(this|questo|questa|questi|queste)\s+(one|is|does|do|includes?|included|covered|available|possible|required|allowed|free|valid|costs?|means?|works?|covers?|comes?|has|will|can|plan|option|item|product|service|package|offer|add-?on|è|costa|include|comprende|vale|piano|opzione|prodotto|servizio|pacchetto|offerta)\b/i;
// "there" is a pronoun only when it ENDS the message ("do you deliver there?"). Mid-sentence
// it is existential or part of a phrase: "is there parking", "is my info still there if…".
const THERE_POINTS_BACK = /\bthere\s*[?.!]*\s*$/i;
// "the pro one", "the clinic one" can be a back-reference — or the tail of a long, complete
// question. A SHORT message ending that way points back; a long one carries its own context.
const THE_X_ONE = /\bthe \w+ one\b/i;
const THE_X_ONE_MAX_WORDS = 10;

// A SHORT message (the 4-words-or-fewer rule) is still a complete question when it addresses
// the business directly, names a brand, or is the "what does X do" overview opener — the
// most common first thing said on a call (§6.20). The rewrite would return those unchanged.
//
// Deliberately NOT here: a list of business nouns (price, refund, shipping…). It would exempt
// "Who pays for shipping?" — a real follow-up in eval-questions.mjs — so recall on genuine
// follow-ups would drop; the noun vocabulary belongs to each tenant, not to this file.
const SECOND_PERSON = /\b(you|your|yours|voi|vostr[aeio]|tuo|tua|tuoi|tue)\b/i;
// Internal capital (ClinicHMS, StorePulse), a capitalised word that is not the first, or a digit.
const BRAND_OR_NUMBER = /[a-zà-ÿ][A-Z]|\s[A-Z][a-zà-ÿ]+|\d/;
const OVERVIEW_FRAME = /^\W*(what|who)\s+(is|are|does|do)\s+[\w'’-]+\s+(do|about|mean|sell|offer|provide)\b/i;
const isSelfContainedShort = (text) => SECOND_PERSON.test(text) || BRAND_OR_NUMBER.test(text) || OVERVIEW_FRAME.test(text);

/** @param {string} message */
export function isAcknowledgement(message) {
  return ACKNOWLEDGEMENT.test(String(message ?? ""));
}

/**
 * Cheap, local, no model call: does this message probably depend on the
 * conversation before it? This only decides whether to SPEND a rewrite; getting
 * it wrong costs latency (a needless call) or recall (a missed follow-up — which
 * the empty-first-pass trigger in retrieveForTurn then still catches), never
 * correctness.
 *
 * @param {string} message
 */
export function needsContext(message) {
  const text = String(message ?? "").trim();
  if (!text || isAcknowledgement(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (ELLIPSIS_OPENER.test(text) || ANAPHORA.test(text) || THIS_POINTS_BACK.test(text) || THERE_POINTS_BACK.test(text)) return true;
  if (words.length <= THE_X_ONE_MAX_WORDS && THE_X_ONE.test(text)) return true;
  return words.length <= SHORT_MESSAGE_WORDS && !isSelfContainedShort(text);
}

/** The customer's most recent previous question, or null. */
function lastCustomerTurn(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user" && String(history[i].content ?? "").trim()) {
      return String(history[i].content).trim();
    }
  }
  return null;
}

/**
 * Strategy `concat`: "<previous question> <message>". Free, deterministic — and
 * blind to anything only the ASSISTANT said ("the second one" after it listed
 * two add-ons), which is what the rewrite strategy exists to cover.
 */
export function concatQuery({ history, message }) {
  const previous = lastCustomerTurn(history);
  return previous ? `${previous} ${message}` : message;
}

/** One line, no quotes or "Query:" labels; null if it is not a usable query. */
function cleanRewrite(raw) {
  const line = String(raw ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const cleaned = line
    .replace(/^(standalone )?(search )?query\s*:\s*/i, "")
    .replace(/^["'`“”«]+|["'`“”»]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > MAX_QUERY_CHARS) return null;
  return cleaned;
}

/**
 * Strategy `rewrite`. Routed through llm.js like every other model call, so it
 * gets the same provider fallback — and FAILS SOFT: any error, timeout or
 * unusable output returns the raw message with status "failed". A reply must
 * never be lost to an optional search-quality step.
 *
 * Status "skipped" is a failure that cost NOTHING: the circuit breaker (llm.js) is open
 * after repeated failures/timeouts, so no call was made and the raw message is searched
 * at once instead of after another full timeout.
 *
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.history
 * @param {string} args.message
 * @param {number} [args.timeoutMs]
 * @param {typeof generateRewrite} [args.generate] injectable for tests; the real llm.js call by default
 * @returns {Promise<{query: string, status: "rewritten"|"unchanged"|"failed"|"skipped", ms: number, error?: string}>}
 */
export async function rewriteQuery({ history, message, timeoutMs = REWRITE_TIMEOUT_MS, generate = generateRewrite }) {
  const started = Date.now();
  try {
    const raw = await generate({
      systemInstruction: buildQueryRewriteInstruction(),
      history: [
        {
          role: "user",
          parts: [
            {
              text: buildQueryRewriteInput({
                history: history.slice(-REWRITE_CONTEXT_MESSAGES),
                message,
              }),
            },
          ],
        },
      ],
      timeoutMs,
    });

    const query = cleanRewrite(raw);
    const ms = Date.now() - started;
    if (!query) return { query: message, status: "failed", ms, error: "unusable rewrite output" };

    const same = query.toLowerCase() === String(message).trim().toLowerCase();
    return { query, status: same ? "unchanged" : "rewritten", ms };
  } catch (err) {
    const error = String(err?.message ?? err).slice(0, 160);
    if (err instanceof CircuitOpenError) {
      // Expected while the provider is down, once per triggered turn: not worth a log line each.
      return { query: message, status: "skipped", ms: Date.now() - started, error };
    }
    console.warn(`[query] rewrite failed, searching the raw message instead: ${error}`);
    return { query: message, status: "failed", ms: Date.now() - started, error };
  }
}

/**
 * Retrieve for one customer turn.
 *
 * TRIGGER RULE for spending a model call (strategy `rewrite`), in order:
 *   1. No earlier turns            → search the message as typed. A first
 *      message cannot be a follow-up, and most calls begin with a complete
 *      question.
 *   2. needsContext(message)       → rewrite BEFORE searching (short, opens with
 *      "and/but/what about", or points back with "that/it/the Pro one").
 *   3. Otherwise search as typed, and ONLY IF that returns nothing and the
 *      message is not a pleasantry → rewrite and search again. This is the
 *      safety net for follow-ups the cheap check missed; a message that already
 *      retrieves fine never pays for a model call.
 * `concat` follows the same rule with a free query builder. `raw` never builds
 * one.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.message the customer's latest message
 * @param {Array<{role: string, content: string}>} args.history turns BEFORE this
 *   message, oldest first (NOT including it)
 * @param {number} [args.topK]
 * @param {"raw"|"concat"|"rewrite"} [args.strategy]
 * @param {"and"|"or"} [args.keywordQuery] keyword-query override, eval harness only (retrieve.js)
 * @param {number} [args.rewriteTimeoutMs] override of the rewrite budget — ONLY
 *   the eval harness passes this (via the debug route), to measure the strategy's
 *   quality separately from the provider's latency; respond() never does.
 * @param {boolean} [args.speculative] override of SPECULATIVE_RAW_SEARCH (tests, eval)
 * @param {{retrieve?: Function, rewrite?: Function}} [args.deps] stubs for tests ONLY
 * @returns {Promise<{chunks: object[], searchQuery: string, strategy: string,
 *   trigger: null|"heuristic"|"empty", rewrite: null|{query: string, status: string, ms: number, error?: string}}>}
 */
export async function retrieveForTurn({
  tenantId,
  message,
  history,
  topK,
  strategy = DEFAULT_QUERY_STRATEGY,
  rewriteTimeoutMs,
  keywordQuery,
  speculative = SPECULATIVE_RAW_SEARCH,
  deps = {},
}) {
  const retrieveChunks = deps.retrieve ?? retrieveRelevantChunks;
  const rewrite = deps.rewrite ?? rewriteQuery;
  const retrieve = (query) => retrieveChunks({ tenantId, query, topK, keywordQuery });
  const resolved = { searchQuery: message, strategy, trigger: null, rewrite: null };

  if (strategy === "raw" || !history.length) {
    return { chunks: await retrieve(message), ...resolved };
  }

  const build = async () =>
    strategy === "concat"
      ? { query: concatQuery({ history, message }), status: "concat", ms: 0 }
      : rewrite({ history, message, timeoutMs: rewriteTimeoutMs });

  if (needsContext(message)) {
    if (speculative && strategy === "rewrite") {
      // Raw search and rewrite start together (SPECULATIVE_RAW_SEARCH, above, has the
      // cost/benefit). The raw promise must never become an unhandled rejection when the
      // rewritten query wins and it is never awaited.
      const raw = retrieve(message);
      raw.catch(() => {});
      const built = await rewrite({ history, message, timeoutMs: rewriteTimeoutMs ?? SPECULATIVE_REWRITE_BUDGET_MS });
      // Only a query that actually CHANGED needs a second search. unchanged / failed /
      // skipped / timed out all mean "the message as typed", which is already in flight.
      const rawUsed = built.status !== "rewritten";
      return {
        chunks: rawUsed ? await raw : await retrieve(built.query),
        ...resolved,
        searchQuery: built.query,
        trigger: "heuristic",
        rewrite: built,
        speculative: { rawUsed },
      };
    }
    const built = await build();
    return {
      chunks: await retrieve(built.query),
      ...resolved,
      searchQuery: built.query,
      trigger: "heuristic",
      rewrite: built,
    };
  }

  const first = await retrieve(message);
  if (first.length || isAcknowledgement(message)) return { chunks: first, ...resolved };

  const built = await build();
  if (built.query === message) {
    return { chunks: first, ...resolved, trigger: "empty", rewrite: built };
  }
  return {
    chunks: await retrieve(built.query),
    ...resolved,
    searchQuery: built.query,
    trigger: "empty",
    rewrite: built,
  };
}
