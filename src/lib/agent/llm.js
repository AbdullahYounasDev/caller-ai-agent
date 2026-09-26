import * as gemini from "./gemini";
import * as openrouter from "./openrouter";
import { isProviderFailure } from "./retry";

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
 * existing row in the same migration. See §5.5 of CLAUDE.md.
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
 * @param {string} text
 * @returns {Promise<number[]>} a 768-dimension vector
 */
export function embedText(text) {
  return gemini.embedText(text);
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

/** For logging and the admin harness — the whole configured chain, regardless
 *  of which link actually answers any given request (see the per-call
 *  onProvider callback above for that). */
export function describeChatProvider() {
  return providerChain()
    .map(({ name }) => describeProvider(name))
    .join(" → ");
}
