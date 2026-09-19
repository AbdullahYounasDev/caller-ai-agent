import { GoogleGenAI } from "@google/genai";

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

/**
 * Retry transient upstream failures.
 *
 * NOT speculative hardening — during the first live run of this pipeline, Gemini
 * returned 503 "model is currently experiencing high demand" on roughly one call
 * in five. Without a retry, each one surfaced to a real customer as "something
 * went wrong" in the middle of a conversation with a business.
 *
 * Only genuinely transient statuses are retried. A 400 or 403 means the request
 * or the API key is wrong, and retrying it just makes the customer wait longer
 * for the same failure.
 *
 * Bounded at 3 attempts (~1.2s of added delay worst case) because someone is
 * waiting for a reply. If all three fail, the caller's try/catch turns it into
 * a translated error — see the widget route.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

async function withRetry(operation, label) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const status = err?.status ?? err?.code;
      if (!RETRYABLE_STATUSES.has(status) || attempt === MAX_ATTEMPTS) throw err;

      // Exponential backoff with jitter. The jitter matters under real load:
      // without it, every request that failed in the same spike retries at the
      // same instant and recreates the spike.
      const delay = 300 * 2 ** (attempt - 1) + Math.random() * 200;
      console.warn(
        `[gemini] ${label} failed with ${status}, retrying in ${Math.round(delay)}ms ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// gemini-embedding-001 defaults to 3072-dim output (Matryoshka-truncatable).
// We pin it to 768 — one of Google's three officially recommended sizes —
// to keep storage and index cost down. This MUST match the vector(768)
// column in prisma/schema.prisma; if you ever change one, change both.
const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

// Gemini model names get retired/replaced over time on Google's side (this
// exact string has already changed once) — if generateReply() ever 404s with
// a "no longer available" message, that error tells you the current
// replacement model name directly; swap it in here. Nothing else in the RAG
// pipeline depends on which chat model this is.
const CHAT_MODEL = "gemini-3.6-flash";

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
    "embedContent"
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
    "generateContent"
  );

  return response.text;
}
