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
 * EVERY CALL MUST UNDERSTAND URDU AND ENGLISH, whichever language the business answers
 * in (§7): the reply language decides what the agent SAYS, never what it can HEAR. A
 * business that chose English still has callers who speak Urdu, or mix the two in one
 * sentence, and a recogniser picked from the reply language turned that Urdu into
 * confident English nonsense. So the choice below does not look at the reply language.
 *
 * TWO ENGINES:
 *
 *   local  NVIDIA Parakeet via sherpa-onnx, on this machine. Fast (~0.2–0.5 s), free,
 *          accurate for English (and 24 other European languages). CANNOT DO URDU.
 *   groq   Whisper large-v3 on Groq's API (free tier, needs GROQ_API_KEY). Understands
 *          Urdu, English and Urdu/English code-switching — the way Pakistani callers
 *          actually speak. There is no local Urdu model good enough to ship: the best
 *          open CPU options score 27–34% word error on Urdu (§6.24).
 *
 *   VOICE_STT_PROVIDER = "auto" (default) | "local" | "groq"
 *     auto  → groq whenever GROQ_API_KEY is set (every call can be in Urdu); local
 *             otherwise — the call still works in English and the timeline says that
 *             Urdu speech is not understood (stt.urdu_unavailable)
 *     local → always Parakeet (an Urdu-speaking caller will NOT be understood)
 *     groq  → always Whisper
 *
 * Whisper is NOT told which language it is hearing: the caller may use either, and a
 * fixed hint makes it force the other language into the wrong one. What it gets instead
 * is a short primer in Urdu script plus English (so short Urdu comes back in Urdu script,
 * and English words inside Urdu sentences stay English). If it still answers in Devanagari
 * — it sometimes writes short Urdu as Hindi — the same audio is asked once more with
 * language=ur.
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
     * The transcriber for one call. It takes no language: see the header.
     * @param {{vocabulary?: string[]}} [call]
     * @returns {Transcriber}
     */
    forCall({ vocabulary = [] } = {}) {
      const useGroq = mode === "groq" || (mode === "auto" && Boolean(groqKey));
      const transcriber = useGroq
        ? groqTranscriber({ apiKey: groqKey, model: groqModel, vocabulary, fallback: local, fetchImpl })
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
    // Parakeet covers 25 European languages — English included, Urdu not (see the header).
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
 * Whisper's prompt is "the text that came before this audio". This one is the spelling
 * and script primer: Urdu in Urdu script, English words inside Urdu, plain English.
 */
const WHISPER_PRIMER = "السلام علیکم۔ Hello. آپ کی appointment کب کی ہے؟ Thank you, شکریہ۔";

/** Hindi's script. Whisper sometimes writes short Urdu in it, which nothing downstream reads. */
const DEVANAGARI = /[\u0900-\u097F]/;

/**
 * Exported for tests (fake fetch).
 * @param {object} args
 * @param {string} [args.language]  an explicit hint; the product leaves it unset (see the header)
 * @returns {Transcriber}
 */
export function groqTranscriber({ apiKey, model, language, vocabulary = [], fallback, fetchImpl = fetch }) {
  const id = `groq:${model}`;
  const prompt = [vocabulary.join(", "), WHISPER_PRIMER].filter(Boolean).join(". ");

  async function ask(samples, hint) {
    const form = new FormData();
    form.append("file", new Blob([encodeWav(samples, SAMPLE_RATE)], { type: "audio/wav" }), "utterance.wav");
    form.append("model", model);
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (hint) form.append("language", hint);
    // Whisper reads its prompt as the text that came before this audio — the standard
    // way to teach it how an unusual name is spelled, and here which script to write in.
    form.append("prompt", prompt);

    const res = await fetchImpl(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(HOSTED_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Groq STT HTTP ${res.status}`);
    const data = await res.json();
    return String(data?.text ?? "").trim();
  }

  return {
    id,
    understandsUrdu: true,
    async transcribe(samples) {
      const started = performance.now();
      try {
        let text = await ask(samples, language);
        // Urdu written in Devanagari is Hindi to every reader downstream: ask again, once,
        // telling Whisper it is Urdu.
        if (!language && DEVANAGARI.test(text)) text = (await ask(samples, "ur")) || text;
        return { text, ms: Math.round(performance.now() - started), engine: id };
      } catch (err) {
        const reason = err?.name === "TimeoutError" ? `timed out after ${HOSTED_TIMEOUT_MS} ms` : String(err?.message ?? err);
        console.warn(`[voice] ${id} failed (${reason}) — transcribing locally instead`);
        const result = await fallback.transcribe(samples);
        return { ...result, ms: Math.round(performance.now() - started), fallbackReason: reason.slice(0, 160) };
      }
    },
  };
}
