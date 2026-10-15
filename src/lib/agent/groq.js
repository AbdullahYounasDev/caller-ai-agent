import { createOpenAiCompatibleProvider } from "./openai-compatible";

/**
 * Groq chat provider — the FAST one. CHAT ONLY (embeddings stay on Gemini, llm.js, §6.2).
 *
 * WHY IT EXISTS: on a phone call the time to the model's first token IS the silence
 * the caller hears. Measured on Gemini's free tier with the real voice prompt (708
 * input tokens, no thinking): 3.5–10 s to the first token on every model tried, random
 * from one call to the next — free-tier queueing, not anything a request can tune
 * (§6.24). Groq serves open models on its own inference hardware with a free tier;
 * published time to first token is ~0.7–1 s.
 *
 *   GROQ_API_KEY            free at console.groq.com (the same key powers Urdu speech
 *                           recognition — lib/voice/speech/stt.js)
 *   GROQ_MODEL              default "openai/gpt-oss-120b" — strong multilingual (Urdu)
 *   GROQ_REASONING_EFFORT   optional; "low" for gpt-oss keeps reasoning short before the
 *                           answer starts. Omit it for a model that does not take it —
 *                           Groq rejects the field there (a 400, our bug, no fallback).
 *
 * The model list on a free tier changes; check the console before relying on a model.
 */
const DEFAULT_MODEL = "openai/gpt-oss-120b";

export const { generateReply, generateReplyStream } = createOpenAiCompatibleProvider({
  label: "Groq",
  baseUrl: (env) => env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  apiKeyEnv: "GROQ_API_KEY",
  model: (env) => env.GROQ_MODEL || DEFAULT_MODEL,
  extraBody: (env) => (env.GROQ_REASONING_EFFORT ? { reasoning_effort: env.GROQ_REASONING_EFFORT } : {}),
});

export const MODEL = (env = process.env) => env.GROQ_MODEL || DEFAULT_MODEL;
