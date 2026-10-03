import { GoogleGenAI } from "@google/genai";
import { withRetry } from "./retry";
import { USE_EMBEDDING_TASK_TYPES } from "./embed-scheme";

/**
 * Gemini provider. Chat AND embeddings.
 *
 * Nothing outside lib/agent/llm.js should import this file directly — the chat
 * half is swappable and the embedding half is not, and llm.js is where that
 * distinction is enforced and explained.
 */

// One client for the whole app, created lazily — so a missing GEMINI_API_KEY
// only breaks the first real API call, not the build or an unrelated import.
let client;
function getClient() {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set — add it to your local .env file");
    }
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

// gemini-embedding-001 defaults to 3072-dim output (Matryoshka-truncatable).
// We pin it to 768 — one of Google's three officially recommended sizes —
// to keep storage and index cost down. This MUST match the vector(768)
// column in prisma/schema.prisma; if you ever change one, change both.
const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

// Gemini model names get retired/replaced over time on Google's side, and on
// the FREE TIER each model carries its OWN separate daily quota — so switching
// model is the normal way to keep working once one is exhausted, not an
// exceptional event. That makes it config, not code: `OPENROUTER_MODEL` was
// already env-driven and this being hardcoded was an inconsistency.
//
// Verified free and working (2026-09-20): gemini-3.5-flash-lite,
// gemini-flash-lite-latest, gemini-3.1-flash-lite, gemini-3.5-flash.
// The `-lite` models answered in ~1s; gemini-3.5-flash took ~15s.
//
// If a call 404s with "no longer available", the error names the replacement
// directly — put it in GEMINI_CHAT_MODEL. Nothing else in the RAG pipeline
// depends on which chat model this is.
// Exported so llm.js can report the exact model that answered a given request
// (the test chat surfaces it) without duplicating this default elsewhere.
export const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || "gemini-3.5-flash-lite";

// Which side of the retrieval a text is on. Gemini's embedding model takes a
// `taskType` so that a QUESTION and the PASSAGE that answers it land closer
// together than two arbitrary texts would — a question and its answer are not
// similar text, and symmetric embedding leaves that gap in every distance.
const TASK_TYPE_FOR_ROLE = { document: "RETRIEVAL_DOCUMENT", query: "RETRIEVAL_QUERY" };

function embedConfig(role) {
  if (!TASK_TYPE_FOR_ROLE[role]) {
    // No default on purpose: a caller that does not know which side it is on
    // would otherwise embed with the wrong one without a sound (§6.2's worst
    // failure mode, by a smaller route).
    throw new Error(`embed role must be "document" or "query" (got ${JSON.stringify(role)})`);
  }
  return {
    outputDimensionality: EMBEDDING_DIMENSIONS,
    ...(USE_EMBEDDING_TASK_TYPES ? { taskType: TASK_TYPE_FOR_ROLE[role] } : {}),
  };
}

/**
 * Embed several texts in ONE request — 768-dim vectors, in input order.
 *
 * This saves LATENCY, not quota: the free-tier cap is counted per text (probed
 * with a near-empty quota: batches of 2, 3 and 5 succeeded, a batch of 10 got a
 * 429, then three single-text calls succeeded — a per-request cap would have
 * let the batch of 10 through). Batches also fail whole: one 429 loses all of it.
 *
 * @param {string[]} texts
 * @param {{role: "document"|"query"}} options
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, { role } = {}) {
  const config = embedConfig(role);
  if (!texts.length) return [];

  const ai = getClient();
  const response = await withRetry(
    () => ai.models.embedContent({ model: EMBEDDING_MODEL, contents: texts, config }),
    "gemini:embed"
  );

  const vectors = (response?.embeddings ?? []).map((e) => e?.values);
  // A short or misordered reply would attach vectors to the wrong chunks and
  // retrieval would return confident nonsense — refuse it instead.
  if (vectors.length !== texts.length || vectors.some((v) => !v?.length)) {
    throw new Error(
      `Gemini returned ${vectors.length} embedding(s) for ${texts.length} text(s) — refusing to store a mismatched batch`
    );
  }
  return vectors;
}

/**
 * Embed a single piece of text into a 768-dim vector.
 * @param {string} text
 * @param {{role: "document"|"query"}} options
 * @returns {Promise<number[]>}
 */
export async function embedText(text, { role } = {}) {
  return (await embedTexts([text], { role }))[0];
}

/**
 * Generate a chat reply from a system instruction + conversation history.
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
 * @param {string} [args.model] overrides CHAT_MODEL for this one call — used by the
 *   query-rewrite step (GEMINI_REWRITE_MODEL, see llm.js). Absent = the chat model.
 * @returns {Promise<string>}
 */
export async function generateReply({ systemInstruction, history, model }) {
  const ai = getClient();
  const response = await withRetry(
    () =>
      ai.models.generateContent({
        model: model || CHAT_MODEL,
        contents: history,
        config: { systemInstruction },
      }),
    "gemini:chat"
  );

  return response.text;
}

/**
 * Same as generateReply, but yields the reply in pieces as the model produces it.
 *
 * WHY THIS EXISTS: a chat that sits blank for three seconds and then dumps a
 * paragraph reads as broken, even when it's fast. Text appearing as it's written
 * is the difference between an agent that feels alive and one that feels
 * stuck. It matters far more on a CALL: voice cannot start speaking until it has
 * text, so streaming is what keeps first-audio latency survivable. That is why
 * the test chat streams too — the path stays exercised rather than being
 * rebuilt when telephony lands.
 *
 * RETRY BEHAVIOUR IS DELIBERATELY NARROWER HERE. Only opening the stream is
 * retried. Once the first token has reached the customer we cannot retry —
 * a second attempt would restart the sentence from the beginning and the reply
 * would visibly rewrite itself. A mid-stream failure propagates instead.
 *
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
 * @param {(chunk: string) => void} args.onChunk called with each new piece of text
 * @returns {Promise<string>} the complete reply, for persisting
 */
export async function generateReplyStream({ systemInstruction, history, onChunk }) {
  const ai = getClient();

  const stream = await withRetry(
    () =>
      ai.models.generateContentStream({
        model: CHAT_MODEL,
        contents: history,
        config: { systemInstruction },
      }),
    "gemini:chat-stream"
  );

  let full = "";
  for await (const chunk of stream) {
    const text = chunk?.text;
    // Chunks can legitimately carry no text (safety metadata, usage info), so
    // an empty one is skipped rather than treated as the end of the stream.
    if (!text) continue;
    full += text;
    onChunk(text);
  }

  return full;
}
