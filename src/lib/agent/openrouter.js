import { createOpenAiCompatibleProvider, toOpenAiMessages, supportsSystemRole } from "./openai-compatible";

/**
 * OpenRouter chat provider. CHAT ONLY — OpenRouter has no embedding models at all
 * (verified across all 447 of them), so embeddings stay on Gemini. See the header of
 * llm.js for why that is not a limitation to work around but a constraint to respect.
 *
 * The dialect itself lives in openai-compatible.js, shared with groq.js.
 *
 * OPENROUTER_BASE_URL is overridable so the streaming path can be driven against a local
 * stand-in (scripts/test-openrouter.mjs) without depending on a shared free-tier pool.
 * For Groq, use LLM_PROVIDER=groq (groq.js) rather than pointing this at Groq: the two
 * can then be primary and fallback at the same time.
 */
const DEFAULT_MODEL = "google/gemma-4-31b-it:free";

export const { generateReply, generateReplyStream } = createOpenAiCompatibleProvider({
  label: "OpenRouter",
  baseUrl: (env) => env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENROUTER_API_KEY",
  model: (env) => env.OPENROUTER_MODEL || DEFAULT_MODEL,
  // OpenRouter attributes traffic by these and surfaces them on their model leaderboards.
  // Harmless, and it makes our usage identifiable in their dashboard when debugging a spike.
  headers: (env) => ({ "HTTP-Referer": env.PUBLIC_APP_URL || "http://localhost:3000", "X-Title": "Caller AI Agent" }),
});

export const MODEL = (env = process.env) => env.OPENROUTER_MODEL || DEFAULT_MODEL;

// Exported for tests — the message translation is the part most likely to break
// silently when a model or provider changes.
export const __testing = { toOpenAiMessages, supportsSystemRole };
