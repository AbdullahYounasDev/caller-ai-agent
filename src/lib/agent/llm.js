import * as gemini from "./gemini";
import * as openrouter from "./openrouter";
import { isProviderFailure } from "./retry";
import { createCircuitBreaker, runGuarded } from "./breaker";

/**
 * ███ THE LLM SEAM ███
 *
 * Everything in the agent that talks to a model goes through this file. Nothing
 * else imports a provider directly.
 *
 * ── THE ONE RULE THAT MATTERS ────────────────────────────────────────────
 * THE CHAT MODEL IS SWAPPABLE. THE EMBEDDING MODEL IS NOT.
 *
 * `knowledge_chunks.embedding` is `vector(768)` and every row in it was
 * produced by Gemini's `gemini-embedding-001`. Embeddings from two different
 * models are not comparable — they are coordinates in different spaces — so
 * embedding a QUERY with one model and comparing it to chunks embedded with
 * another returns confident nonsense. Retrieval would not error; it would
 * quietly return the wrong documents, and the agent would answer fluently from
 * them. That is the worst possible failure mode for a RAG system.
 *
 * So `embedText` is hard-wired to Gemini and takes no provider argument. It is
 * not a gap waiting to be filled: OpenRouter has NO embedding models at all
 * (checked across all 447), which is why the chat model is the only half that
 * moves.
 *
 * Changing the embedding model means changing the column AND re-embedding every
 * existing row in the same migration. See §6.2 of CLAUDE.md (which also covers the
 * smaller changes — title prefix, taskType — that need a re-embed and a re-measured threshold).
 * ─────────────────────────────────────────────────────────────────────────
 *
 * CONFIG
 *   LLM_PROVIDER           "openrouter" | "gemini"   (default: gemini)
 *   LLM_FALLBACK_PROVIDER  same values, or unset to disable fallback
 *
 * The fallback exists because both providers' free tiers fail often and for
 * different reasons — Gemini on a daily quota, OpenRouter's free pool on
 * upstream congestion. When one is down the other usually is not, and a
 * business's customer should not see an error because a shared pool was busy.
 */

const PROVIDERS = { gemini, openrouter };

function resolveProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(
      `Unknown LLM provider "${name}". Set LLM_PROVIDER to one of: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }
  return provider;
}

/** The chat provider chain: primary first, optional fallback second. */
function providerChain() {
  const primary = process.env.LLM_PROVIDER || "gemini";
  const fallback = process.env.LLM_FALLBACK_PROVIDER;

  const chain = [{ name: primary, provider: resolveProvider(primary) }];
  if (fallback && fallback !== primary) {
    chain.push({ name: fallback, provider: resolveProvider(fallback) });
  }
  return chain;
}

/** Human-readable label for one provider, including the specific model — not
 *  just "gemini" vs "openrouter". Shared by describeChatProvider() (the whole
 *  configured chain) and the per-call onProvider callback below (which one
 *  actually answered, after any fallback). */
function describeProvider(name) {
  return name === "openrouter"
    ? `openrouter:${process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free"}`
    : `gemini:${gemini.CHAT_MODEL}`;
}

/**
 * Run `call` against the provider chain, moving on when a provider is at fault.
 *
 * Only PROVIDER failures fall through — rate limits, outages, bad credentials,
 * a model that no longer exists. A malformed request or an empty reply is our
 * bug, and retrying it on a second provider would just produce the same bad
 * result while doubling the latency and the bill.
 *
 * @param {(provider: object, name: string) => Promise<any>} call
 * @param {string} label
 * @param {(description: string) => void} [onProvider] told which provider
 *   actually served the request, once it has — used by respond.js to report
 *   "answered by" back to the test chat. Optional and best-effort: never lets
 *   a bug in the caller's callback break the response it is describing.
 */
async function withProviderFallback(call, label, onProvider) {
  const chain = providerChain();
  let lastError;

  for (let i = 0; i < chain.length; i++) {
    const { name, provider } = chain[i];
    try {
      const result = await call(provider, name);
      try {
        onProvider?.(describeProvider(name));
      } catch {
        // Reporting which provider answered must never break the answer.
      }
      return result;
    } catch (err) {
      lastError = err;
      const isLast = i === chain.length - 1;
      if (isLast || !isProviderFailure(err)) throw err;

      console.warn(
        `[llm] ${label}: provider "${name}" failed (${err?.status ?? "?"}) — ` +
          `falling back to "${chain[i + 1].name}". Cause: ${String(err?.message).slice(0, 160)}`
      );
    }
  }

  throw lastError;
}

/**
 * Embed text for the RAG pipeline. ALWAYS Gemini — see the rule above.
 *
 * `role` is REQUIRED and says which side of retrieval the text is on:
 * "document" for a chunk being stored, "query" for a question being searched.
 * It is not a provider argument — there is still only one provider. Whether it
 * reaches the API as a Gemini taskType is decided in embed-scheme.js.
 *
 * @param {string} text
 * @param {{role: "document"|"query"}} options
 * @returns {Promise<number[]>} a 768-dimension vector
 */
export function embedText(text, options) {
  return gemini.embedText(text, options);
}

/**
 * Embed many texts in one request (see gemini.embedTexts: faster, NOT cheaper —
 * the free quota is per text).
 * @param {string[]} texts
 * @param {{role: "document"|"query"}} options
 * @returns {Promise<number[][]>}
 */
export function embedTexts(texts, options) {
  return gemini.embedTexts(texts, options);
}

export const EMBEDDING_DIMENSIONS = gemini.EMBEDDING_DIMENSIONS;

/**
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
 * @param {(description: string) => void} [args.onProvider] which provider/model
 *   actually answered — e.g. "gemini:gemini-3.5-flash-lite" — told after the
 *   call succeeds. Optional; the test chat uses this to show "answered by".
 * @returns {Promise<string>}
 */
export function generateReply({ onProvider, ...args }) {
  return withProviderFallback(
    (provider) => provider.generateReply(args),
    "generateReply",
    onProvider
  );
}

/**
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
 * @param {(chunk: string) => void} args.onChunk
 * @param {(description: string) => void} [args.onProvider] see generateReply.
 * @returns {Promise<string>}
 */
export function generateReplyStream({ onProvider, ...args }) {
  // Falling back mid-stream is safe ONLY because a provider failure here means
  // the stream never opened — openrouter.js and gemini.js both retry the open
  // and let anything after the first token propagate. If that ever changes,
  // this fallback has to become open-only too, or a customer will watch a reply
  // restart itself from a different model.
  return withProviderFallback(
    (provider) => provider.generateReplyStream(args),
    "generateReplyStream",
    onProvider
  );
}

// ── THE QUERY-REWRITE CALL (§6.19) ──────────────────────────────────────────
// An optional, latency-sensitive model call that is not the customer's reply. It gets
// its own budget, its own (optional) model and a circuit breaker, because a degraded
// provider must cost it nothing rather than 3 seconds a turn.

/**
 * Consecutive rewrite failures or timeouts before the rewrite stops being attempted.
 * Three, not one: withRetry already absorbs the odd 503 (about one call in five during
 * live runs), so a single failure says nothing; three in a row means the provider is
 * actually down or out of quota, and each further attempt would just burn 3s.
 */
export const REWRITE_BREAKER_THRESHOLD = 3;

/**
 * How long the rewrite is skipped once the breaker opens. A minute is long enough for a
 * per-MINUTE free-tier rate limit to clear and short enough that a recovered provider
 * is back in use quickly. A daily quota that stays exhausted costs one probe (one turn
 * waiting up to the rewrite budget) per minute — vs. every triggered turn before.
 */
export const REWRITE_BREAKER_COOLDOWN_MS = 60_000;

const rewriteBreaker = createCircuitBreaker({
  threshold: REWRITE_BREAKER_THRESHOLD,
  cooldownMs: REWRITE_BREAKER_COOLDOWN_MS,
});

/**
 * The model the rewrite should use on one provider, or undefined for "the same model the
 * chat uses" — which is what happens unless an operator sets GEMINI_REWRITE_MODEL /
 * OPENROUTER_REWRITE_MODEL, so behaviour is unchanged by default. A smaller, faster
 * model is the point; on the Gemini free tier a separate model also has its OWN daily
 * quota, so rewrites stop competing with replies for it.
 *
 * @param {string} providerName "gemini" | "openrouter"
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined}
 */
export function rewriteModelFor(providerName, env = process.env) {
  const value = providerName === "openrouter" ? env.OPENROUTER_REWRITE_MODEL : env.GEMINI_REWRITE_MODEL;
  return value?.trim() || undefined;
}

/**
 * Generate the rewrite: same provider chain and fallback as every other call, but under
 * a hard timeout and the circuit breaker above. Throws CircuitOpenError instantly while
 * the circuit is open, CallTimeoutError after `timeoutMs`, otherwise whatever the
 * provider threw. Callers fail soft on all three (query.js).
 *
 * NOTE a timed-out call is abandoned, not cancelled: it keeps running (and keeps
 * retrying inside withRetry) in the background and may still spend its quota.
 *
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
 * @param {number} args.timeoutMs
 * @returns {Promise<string>}
 */
export function generateRewrite({ systemInstruction, history, timeoutMs }) {
  return runGuarded(
    rewriteBreaker,
    () =>
      withProviderFallback(
        (provider, name) => provider.generateReply({ systemInstruction, history, model: rewriteModelFor(name) }),
        "rewrite"
      ),
    { timeoutMs }
  );
}

/** For logs and the debug route: the rewrite breaker's current state. */
export const rewriteBreakerState = () => rewriteBreaker.snapshot();

/** For logging and the admin harness — the whole configured chain, regardless
 *  of which link actually answers any given request (see the per-call
 *  onProvider callback above for that). */
export function describeChatProvider() {
  return providerChain()
    .map(({ name }) => describeProvider(name))
    .join(" → ");
}
