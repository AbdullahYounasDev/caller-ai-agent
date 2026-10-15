import { createSerialQueue } from "../serial";
import { SAMPLE_RATE } from "../config";
import { encodeWav } from "../audio";
import { correctTranscript } from "../vocabulary";

/**
 * ███ THE SPEECH-TO-TEXT SEAM ███
 *
 * The call session asks this file for ONE transcriber per call (`forCall`) and only ever
 * calls its `transcribe(samples)`. Which engine answers is decided here, exactly like
 * llm.js decides which chat model answers — moving STT to a hosted provider or a
 * dedicated model server (§9.2) is a change to this file, never to the session.
 *
 * TWO ENGINES, chosen per call by the language the call can be spoken in:
 *
 *   local  NVIDIA Parakeet via sherpa-onnx, on this machine. Fast (~0.2–0.5 s), free,
 *          accurate for English and Italian (25 European languages). CANNOT DO URDU.
 *   groq   Whisper large-v3 on Groq's API (free tier, needs GROQ_API_KEY). Understands
 *          Urdu and Urdu/English code-switching — the way Pakistani callers actually
 *          speak — plus English and Italian. There is no local Urdu model good enough to
 *          ship: the best open CPU options score 27–34% word error on Urdu (§6.24).
 *
 *   VOICE_STT_PROVIDER = "auto" (default) | "local" | "groq"
 *     auto  → groq for a call that can be in Urdu (reply language "ur" or "auto") when
 *             GROQ_API_KEY is set; local otherwise
 *     local → always Parakeet (an Urdu-speaking caller will NOT be understood)
 *     groq  → always Whisper
 *
 * A hosted call that fails or times out falls back to Parakeet for that utterance — a
 * caller speaking English is still understood, and the failure is reported, not hidden.
 *
 * NAMES: neither engine has heard of the business. Every transcriber `forCall` returns
 * corrects sound-alikes of the call's vocabulary (the business name — ../vocabulary.js),
 * and Whisper is also given the vocabulary as its spelling prompt. The result carries
 * `corrections` ("Nairan→Nyron") so the call timeline shows what was actually heard.
 */

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/** Hosted STT is on the critical path of every turn; past this the local engine answers. */
const HOSTED_TIMEOUT_MS = 6000;

/**
 * @typedef {{ id: string, understandsUrdu: boolean, transcribe(samples: Float32Array): Promise<{text: string, ms: number, engine: string, fallbackReason?: string, corrections?: string[]}> }} Transcriber
 */

/**
 * @param {object} args
 * @param {object} args.engine  the loaded local speech engine (engine.js)
 * @param {Record<string, string|undefined>} [args.env]
 * @param {typeof fetch} [args.fetchImpl]  injectable for tests
 */
export function createSpeechToText({ engine, env = process.env, fetchImpl = fetch }) {
  const mode = env.VOICE_STT_PROVIDER || "auto";
  if (!["auto", "local", "groq"].includes(mode)) {
    throw new Error(`Unknown VOICE_STT_PROVIDER "${mode}". Use auto, local or groq.`);
  }
  const groqKey = env.GROQ_API_KEY;
  if (mode === "groq" && !groqKey) throw new Error('VOICE_STT_PROVIDER is "groq" but GROQ_API_KEY is not set');

  const local = localTranscriber(engine);
  const groqModel = env.GROQ_STT_MODEL || "whisper-large-v3";

  return {
    /** For the gateway's /health and the call record. */
    describe: () => ({ mode, local: local.id, hosted: groqKey ? `groq:${groqModel}` : null }),

    /**
     * The transcriber for one call.
     * @param {{replyLanguage: "en"|"it"|"ur"|"auto", vocabulary?: string[]}} call
     * @returns {Transcriber}
     */
    forCall({ replyLanguage, vocabulary = [] }) {
      const mayBeUrdu = replyLanguage === "ur" || replyLanguage === "auto";
      const useGroq = mode === "groq" || (mode === "auto" && groqKey && mayBeUrdu);
      // A fixed reply language is a strong hint: it stops Whisper from writing a short
      // Urdu utterance in Hindi's Devanagari script, which it otherwise sometimes does.
      const language = ["en", "it", "ur"].includes(replyLanguage) ? replyLanguage : undefined;
      const transcriber = useGroq
        ? groqTranscriber({ apiKey: groqKey, model: groqModel, language, vocabulary, fallback: local, fetchImpl })
        : local;
      return withVocabulary(transcriber, vocabulary);
    },
  };
}

function localTranscriber(engine) {
  // One recognizer serves every call; decodes run one at a time so concurrent calls
  // queue for it instead of oversubscribing the CPU (or racing the native object).
  const serial = createSerialQueue();
  return {
    id: engine.info.stt,
    // Parakeet covers 25 European languages — not Urdu (see the header).
    understandsUrdu: false,
    async transcribe(samples) {
      return serial(async () => {
        const started = performance.now();
        const stream = engine.recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        // decodeAsync runs on a native worker thread: the event loop keeps taking other
        // callers' audio while this one is being transcribed.
        const result = await engine.recognizer.decodeAsync(stream);
        return { text: String(result?.text ?? "").trim(), ms: Math.round(performance.now() - started), engine: engine.info.stt };
      });
    },
  };
}

/** The same transcriber, with the call's names spelled the way the business spells them. */
function withVocabulary(transcriber, vocabulary) {
  if (!vocabulary.length) return transcriber;
  return {
    ...transcriber,
    async transcribe(samples) {
      const result = await transcriber.transcribe(samples);
      const { text, corrections } = correctTranscript(result.text, vocabulary);
      return corrections.length ? { ...result, text, corrections } : result;
    },
  };
}

/**
 * Exported for tests (fake fetch).
 * @returns {Transcriber}
 */
export function groqTranscriber({ apiKey, model, language, vocabulary = [], fallback, fetchImpl = fetch }) {
  const id = `groq:${model}`;
  return {
    id,
    understandsUrdu: true,
    async transcribe(samples) {
      const started = performance.now();
      try {
        const form = new FormData();
        form.append("file", new Blob([encodeWav(samples, SAMPLE_RATE)], { type: "audio/wav" }), "utterance.wav");
        form.append("model", model);
        form.append("response_format", "json");
        form.append("temperature", "0");
        if (language) form.append("language", language);
        // Whisper reads its prompt as the text that came before this audio — the standard
        // way to teach it how an unusual name is spelled.
        if (vocabulary.length) form.append("prompt", vocabulary.join(", "));

        const res = await fetchImpl(GROQ_TRANSCRIBE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(HOSTED_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Groq STT HTTP ${res.status}`);
        const data = await res.json();
        return { text: String(data?.text ?? "").trim(), ms: Math.round(performance.now() - started), engine: id };
      } catch (err) {
        const reason = err?.name === "TimeoutError" ? `timed out after ${HOSTED_TIMEOUT_MS} ms` : String(err?.message ?? err);
        console.warn(`[voice] ${id} failed (${reason}) — transcribing locally instead`);
        const result = await fallback.transcribe(samples);
        return { ...result, ms: Math.round(performance.now() - started), fallbackReason: reason.slice(0, 160) };
      }
    },
  };
}
