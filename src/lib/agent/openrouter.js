import { withRetry } from "./retry";

/**
 * OpenRouter chat provider. CHAT ONLY — OpenRouter has no embedding models at
 * all (verified across all 447 of them), so embeddings stay on Gemini. See the
 * header of llm.js for why that is not a limitation to work around but a
 * constraint to respect.
 *
 * OpenRouter speaks the OpenAI chat-completions dialect, so this file's real
 * job is translating between our internal message shape (Gemini's `contents`
 * format, which the brain has always used) and that dialect.
 */

// Overridable so the streaming path can be driven against a local stand-in
// (scripts/test-openrouter.mjs) without depending on a shared free-tier pool,
// and so a self-hosted OpenAI-compatible gateway can be pointed at later.
const BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const ENDPOINT = `${BASE_URL}/chat/completions`;
const DEFAULT_MODEL = "google/gemma-4-31b-it:free";

function getConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set — add it to your local .env file");
  }
  return { apiKey, model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL };
}

/**
 * GEMMA HAS NO SYSTEM TURN.
 *
 * Its chat template only defines `user` and `model` turns — unlike Llama or
 * GPT, there is nowhere for a system message to go. Sent one anyway, the
 * behaviour is provider-dependent: it may be silently dropped, which would
 * throw away the entire persona, grounding rule and anti-hallucination guard
 * that prompt.js builds, and the agent would answer as a generic assistant with
 * no idea which business it works for. That failure is quiet and easy to miss —
 * the replies still look plausible.
 *
 * So for Gemma we fold the system instruction into the first user turn, which
 * is what Google's own guidance recommends. Models that do support a system
 * role get a real system message.
 */
function supportsSystemRole(model) {
  return !/(^|\/)gemma/i.test(model);
}

/**
 * Our internal history is Gemini-shaped: [{ role: "user"|"model", parts:[{text}] }].
 * The brain has always spoken that dialect, and changing it would ripple into
 * respond.js and every future channel, so the translation lives here instead.
 */
function toOpenAiMessages({ systemInstruction, history, model }) {
  const messages = history.map((turn) => ({
    role: turn.role === "model" ? "assistant" : "user",
    content: turn.parts.map((p) => p.text).join(""),
  }));

  if (!systemInstruction) return messages;

  if (supportsSystemRole(model)) {
    return [{ role: "system", content: systemInstruction }, ...messages];
  }

  // FOLD INTO THE **LAST** USER TURN, NOT THE FIRST. This is a RAG correctness
  // issue, not a style choice.
  //
  // The system instruction is rebuilt on every turn by prompt.js and carries
  // the knowledge chunks retrieved for THIS question. Folding it into the first
  // user message would attach the current question's context to a message from
  // earlier in the conversation, and push it further away with every turn — so
  // by turn ten the model is reading freshly retrieved pricing next to a
  // long-answered question, with the actual question twenty lines below.
  // Retrieval would still work; grounding would quietly degrade.
  //
  // Keeping it adjacent to the live question also puts the persona, language
  // and grounding rules where recency helps the model follow them.
  //
  // A clear separator matters too: without it the model can read the
  // instructions as part of the customer's message and answer them rather than
  // follow them.
  const folded = `${systemInstruction}\n\n---\n\nCustomer message:\n`;

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) {
    return [...messages, { role: "user", content: folded }];
  }

  const copy = [...messages];
  copy[lastUserIndex] = {
    ...copy[lastUserIndex],
    content: folded + copy[lastUserIndex].content,
  };
  return copy;
}

/** Turn a non-2xx response into an Error carrying `status`, which retry.js reads. */
async function toError(res) {
  const body = await res.json().catch(() => null);
  const raw = body?.error?.metadata?.raw ?? body?.error?.message ?? res.statusText;
  const err = new Error(`OpenRouter ${res.status}: ${raw}`);
  err.status = res.status;
  return err;
}

function baseHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    // OpenRouter attributes traffic by these and surfaces them on their model
    // leaderboards. Harmless, and it makes our usage identifiable in their
    // dashboard when debugging a spike.
    "HTTP-Referer": process.env.PUBLIC_APP_URL || "http://localhost:3000",
    "X-Title": "Caller AI Agent",
  };
}

/**
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
 * @returns {Promise<string>}
 */
export async function generateReply({ systemInstruction, history }) {
  const { apiKey, model } = getConfig();

  const data = await withRetry(async () => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: baseHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages: toOpenAiMessages({ systemInstruction, history, model }),
      }),
    });
    if (!res.ok) throw await toError(res);
    return res.json();
  }, "openrouter:chat");

  // OpenRouter can return 200 with an error body when a provider fails
  // mid-request — treating that as a success would persist an empty reply.
  if (data?.error) {
    const err = new Error(`OpenRouter: ${data.error.message ?? "unknown error"}`);
    err.status = data.error.code ?? 502;
    throw err;
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("OpenRouter returned an empty reply");
  }
  return text;
}

/**
 * Streaming variant. Only opening the stream is retried — once a token has
 * reached the customer, a retry would restart the sentence and the reply would
 * visibly rewrite itself.
 *
 * @param {object} args
 * @param {string} args.systemInstruction
 * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
 * @param {(chunk: string) => void} args.onChunk
 * @returns {Promise<string>} the complete reply, for persisting
 */
export async function generateReplyStream({ systemInstruction, history, onChunk }) {
  const { apiKey, model } = getConfig();

  const res = await withRetry(async () => {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: baseHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages: toOpenAiMessages({ systemInstruction, history, model }),
        stream: true,
      }),
    });
    if (!response.ok) throw await toError(response);
    return response;
  }, "openrouter:chat-stream");

  if (!res.body) throw new Error("OpenRouter returned no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame can straddle two reads,
    // so whatever follows the last separator stays buffered.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        // OpenRouter sends ": OPENROUTER PROCESSING" comment lines as
        // keep-alives while a provider is still thinking. They are not data and
        // JSON.parse would throw on them.
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // a malformed frame must not kill a working stream
        }

        if (parsed?.error) {
          const err = new Error(`OpenRouter: ${parsed.error.message ?? "stream error"}`);
          err.status = parsed.error.code ?? 502;
          throw err;
        }

        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onChunk(delta);
        }
      }
    }
  }

  if (!full.trim()) throw new Error("OpenRouter stream produced no text");
  return full;
}

// Exported for tests — the message translation is the part most likely to break
// silently when a model or provider changes.
export const __testing = { toOpenAiMessages, supportsSystemRole };
