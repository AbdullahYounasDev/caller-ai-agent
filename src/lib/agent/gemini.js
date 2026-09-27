import { GoogleGenAI } from "@google/genai";
import { withRetry } from "./retry";

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

/**
 * Embed a single piece of text into a 768-dim vector.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedText(text) {
  const ai = getClient();
  const response = await withRetry(
    () =>
      ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      }),
    "gemini:embed"
  );

  const values = response?.embeddings?.[0]?.values;
  if (!values) {
    throw new Error("Gemini returned no embedding values for the given text");
  }
  return values;
}

/**
 * Generate a chat reply from a system instruction + conversation history.
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
 * @returns {Promise<string>}
 */
export async function generateReply({ systemInstruction, history }) {
  const ai = getClient();
  const response = await withRetry(
    () =>
      ai.models.generateContent({
        model: CHAT_MODEL,
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
