import { withRetry } from "./retry";

/**
 * ONE IMPLEMENTATION of the OpenAI chat-completions dialect, shared by every provider
 * that speaks it — OpenRouter (openrouter.js), Groq (groq.js), and anything else with an
 * OpenAI-compatible endpoint. CHAT ONLY: embeddings stay on Gemini (llm.js header, §6.2).
 *
 * Its real job is translating between our internal message shape (Gemini's `contents`
 * format, which the brain has always used) and that dialect. Extracted from
 * openrouter.js when Groq was added, because two copies of a streaming SSE parser and
 * a system-turn fold drift — and the second copy always gets one of them wrong.
 *
 * Every setting is read PER CALL from the environment, never at import time: the voice
 * gateway loads .env before importing the app, but an import-time read is how a module
 * ends up quietly using a default (§6.24).
 *
 * @param {object} spec
 * @param {string} spec.label                 "openrouter" | "groq" — in errors and logs
 * @param {(env: object) => string} spec.baseUrl
 * @param {string} spec.apiKeyEnv             e.g. "GROQ_API_KEY"
 * @param {(env: object) => string} spec.model
 * @param {(env: object) => object} [spec.extraBody]  provider-specific request fields
 * @param {(env: object) => object} [spec.headers]    provider-specific headers
 */
export function createOpenAiCompatibleProvider({ label, baseUrl, apiKeyEnv, model, extraBody = () => ({}), headers = () => ({}) }) {
  function config(env = process.env) {
    const apiKey = env[apiKeyEnv];
    if (!apiKey) throw new Error(`${apiKeyEnv} is not set — add it to your local .env file`);
    return {
      apiKey,
      endpoint: `${baseUrl(env).replace(/\/+$/, "")}/chat/completions`,
      model: model(env),
      extra: extraBody(env),
      headers: headers(env),
    };
  }

  const requestHeaders = (cfg) => ({
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
    ...cfg.headers,
  });

  /** Turn a non-2xx response into an Error carrying `status`, which retry.js reads. */
  async function toError(res) {
    const body = await res.json().catch(() => null);
    const raw = body?.error?.metadata?.raw ?? body?.error?.message ?? res.statusText;
    const err = new Error(`${label} ${res.status}: ${raw}`);
    err.status = res.status;
    return err;
  }

  /**
   * @param {object} args
   * @param {string} args.systemInstruction
   * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
   * @param {string} [args.model] overrides the configured model for this one call (the
   *   query-rewrite step — llm.js rewriteModelFor).
   * @returns {Promise<string>}
   */
  async function generateReply({ systemInstruction, history, model: modelOverride }) {
    const cfg = config();
    const useModel = modelOverride || cfg.model;

    const data = await withRetry(async () => {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: requestHeaders(cfg),
        body: JSON.stringify({
          model: useModel,
          messages: toOpenAiMessages({ systemInstruction, history, model: useModel }),
          ...cfg.extra,
        }),
      });
      if (!res.ok) throw await toError(res);
      return res.json();
    }, `${label}:chat`);

    // Some providers return 200 with an error body when an upstream fails mid-request —
    // treating that as a success would persist an empty reply.
    if (data?.error) {
      const err = new Error(`${label}: ${data.error.message ?? "unknown error"}`);
      err.status = data.error.code ?? 502;
      throw err;
    }

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error(`${label} returned an empty reply`);
    return text;
  }

  /**
   * Streaming variant. Only opening the stream is retried — once a token has reached the
   * customer, a retry would restart the sentence and the reply would visibly rewrite itself.
   *
   * @param {object} args
   * @param {string} args.systemInstruction
   * @param {Array<{role: "user"|"model", parts: Array<{text: string}>}>} args.history
   * @param {(chunk: string) => void} args.onChunk
   * @returns {Promise<string>} the complete reply, for persisting
   */
  async function generateReplyStream({ systemInstruction, history, onChunk }) {
    const cfg = config();

    const res = await withRetry(async () => {
      const response = await fetch(cfg.endpoint, {
        method: "POST",
        headers: requestHeaders(cfg),
        body: JSON.stringify({
          model: cfg.model,
          messages: toOpenAiMessages({ systemInstruction, history, model: cfg.model }),
          stream: true,
          ...cfg.extra,
        }),
      });
      if (!response.ok) throw await toError(response);
      return response;
    }, `${label}:chat-stream`);

    if (!res.body) throw new Error(`${label} returned no response body`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; a frame can straddle two reads, so
      // whatever follows the last separator stays buffered.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          // Comment lines (": OPENROUTER PROCESSING") are keep-alives while a provider is
          // still thinking. They are not data and JSON.parse would throw on them.
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
            const err = new Error(`${label}: ${parsed.error.message ?? "stream error"}`);
            err.status = parsed.error.code ?? 502;
            throw err;
          }

          // Only `content` is the answer. Reasoning models stream their reasoning in a
          // separate field (`reasoning`), which must never be spoken or stored.
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onChunk(delta);
          }
        }
      }
    }

    if (!full.trim()) throw new Error(`${label} stream produced no text`);
    return full;
  }

  return { generateReply, generateReplyStream };
}

/**
 * GEMMA HAS NO SYSTEM TURN.
 *
 * Its chat template only defines `user` and `model` turns — unlike Llama or GPT, there
 * is nowhere for a system message to go. Sent one anyway, the behaviour is
 * provider-dependent: it may be silently dropped, which would throw away the entire
 * persona, grounding rule and anti-hallucination guard that prompt.js builds, and the
 * agent would answer as a generic assistant with no idea which business it works for.
 * That failure is quiet and easy to miss — the replies still look plausible.
 *
 * So for Gemma the system instruction is folded into the LAST user turn (see
 * toOpenAiMessages for why the last, not the first). Models that support a system role
 * get a real system message.
 */
export function supportsSystemRole(model) {
  return !/(^|\/)gemma/i.test(model);
}

/**
 * Our internal history is Gemini-shaped: [{ role: "user"|"model", parts:[{text}] }]. The
 * brain has always spoken that dialect, and changing it would ripple into respond.js and
 * every channel, so the translation lives here instead.
 */
export function toOpenAiMessages({ systemInstruction, history, model }) {
  const messages = history.map((turn) => ({
    role: turn.role === "model" ? "assistant" : "user",
    content: turn.parts.map((p) => p.text).join(""),
  }));

  if (!systemInstruction) return messages;

  if (supportsSystemRole(model)) {
    return [{ role: "system", content: systemInstruction }, ...messages];
  }

  // FOLD INTO THE **LAST** USER TURN, NOT THE FIRST. This is a RAG correctness issue,
  // not a style choice.
  //
  // The system instruction is rebuilt on every turn by prompt.js and carries the
  // knowledge chunks retrieved for THIS question. Folding it into the first user message
  // would attach the current question's context to a message from earlier in the
  // conversation, and push it further away with every turn — so by turn ten the model is
  // reading freshly retrieved pricing next to a long-answered question, with the actual
  // question twenty lines below. Retrieval would still work; grounding would quietly
  // degrade.
  //
  // Keeping it adjacent to the live question also puts the persona, language and
  // grounding rules where recency helps the model follow them. A clear separator
  // matters too: without it the model can read the instructions as part of the
  // customer's message and answer them rather than follow them.
  const folded = `${systemInstruction}\n\n---\n\nCustomer message:\n`;

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) return [...messages, { role: "user", content: folded }];

  const copy = [...messages];
  copy[lastUserIndex] = { ...copy[lastUserIndex], content: folded + copy[lastUserIndex].content };
  return copy;
}
