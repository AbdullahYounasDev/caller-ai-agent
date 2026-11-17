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
 * Whisper reports the language it decided on. When that is NEITHER English nor Urdu (a short or clipped utterance
 * sometimes comes back as Arabic, Portuguese, Russian…: "No, nothing" → "Нет, ничего" on a real call) the audio is asked
 * again with English and with Urdu, and the answer it was surer of (its own average log-probability) is kept; the result
 * carries `relanguaged` ("Portuguese→ur") so the timeline shows it. A 429 (rate limit) is waited out once, if the wait is
 * short, before the local engine takes over: that engine cannot hear Urdu at all.
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
     * @param {{vocabulary?: string[], phrase?: string|null}} [call]  `phrase`: the whole business name, when it holds a
     *   word too short to correct alone (vocabulary.js callPhrase)
     * @returns {Transcriber}
     */
    forCall({ vocabulary = [], phrase = null } = {}) {
      const useGroq = mode === "groq" || (mode === "auto" && Boolean(groqKey));
      const transcriber = useGroq
        ? groqTranscriber({ apiKey: groqKey, model: groqModel, vocabulary, phrase, fallback: local, fetchImpl })
        : local;
      return withVocabulary(transcriber, vocabulary, phrase);
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
function withVocabulary(transcriber, vocabulary, phrase = null) {
  if (!vocabulary.length && !phrase) return transcriber;
  return {
    ...transcriber,
    async transcribe(samples) {
      const result = await transcriber.transcribe(samples);
      const { text, corrections } = correctTranscript(result.text, vocabulary, { phrase });
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

/** The languages callers speak to this product (§7). Whisper names them in English, capitalised. */
const SPOKEN_LANGUAGES = new Set(["english", "urdu"]);
/** A rate limit is waited out only when it is this short; the call is live. */
const MAX_RATE_LIMIT_WAIT_MS = 1500;
/** When a 429 says nothing about how long. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 800;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exported for tests (fake fetch).
 * @param {object} args
 * @param {string} [args.language]  an explicit hint; the product leaves it unset (see the header)
 * @returns {Transcriber}
 */
export function groqTranscriber({ apiKey, model, language, vocabulary = [], phrase = null, fallback, fetchImpl = fetch, sleep = delay }) {
  const id = `groq:${model}`;
  const prompt = [phrase, vocabulary.join(", "), WHISPER_PRIMER].filter(Boolean).join(". ");

  /** One request. Returns what Whisper wrote, the language it decided on and how sure it was (null when it did not say). */
  async function request(samples, hint) {
    const form = new FormData();
    form.append("file", new Blob([encodeWav(samples, SAMPLE_RATE)], { type: "audio/wav" }), "utterance.wav");
    form.append("model", model);
    // verbose_json: the same text plus the language it chose and a confidence per segment.
    form.append("response_format", "verbose_json");
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
    if (!res.ok) {
      const error = new Error(`Groq STT HTTP ${res.status}`);
      error.status = res.status;
      error.retryAfter = res.headers?.get?.("retry-after") ?? null;
      throw error;
    }
    const data = await res.json();
    const logprobs = (Array.isArray(data?.segments) ? data.segments : []).map((s) => s?.avg_logprob).filter((v) => Number.isFinite(v));
    return {
      text: String(data?.text ?? "").trim(),
      language: typeof data?.language === "string" ? data.language : null,
      confidence: logprobs.length ? logprobs.reduce((a, b) => a + b, 0) / logprobs.length : null,
    };
  }

  /** request(), waiting out one short rate limit. */
  async function ask(samples, hint) {
    try {
      return await request(samples, hint);
    } catch (err) {
      if (err?.status !== 429) throw err;
      const seconds = Number.parseFloat(err.retryAfter);
      const wait = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : DEFAULT_RATE_LIMIT_WAIT_MS;
      if (wait > MAX_RATE_LIMIT_WAIT_MS) throw err;
      await sleep(wait);
      return request(samples, hint);
    }
  }

  /** The utterance asked again in English and in Urdu: the answer Whisper was surer of. Null if both fail. */
  async function askBothLanguages(samples) {
    const tries = await Promise.all(["en", "ur"].map((hint) => ask(samples, hint).then((r) => ({ ...r, hint }), () => null)));
    const answers = tries.filter((r) => r?.text);
    if (!answers.length) return null;
    // Without a confidence to compare, the first answer (English) stands.
    return answers.reduce((best, r) => ((r.confidence ?? -Infinity) > (best.confidence ?? -Infinity) ? r : best));
  }

  return {
    id,
    understandsUrdu: true,
    async transcribe(samples) {
      const started = performance.now();
      try {
        const first = await ask(samples, language);
        let text = first.text;
        let relanguaged;
        if (!language) {
          if (DEVANAGARI.test(text)) {
            // Urdu written in Devanagari is Hindi to every reader downstream: ask again, once,
            // telling Whisper it is Urdu.
            text = (await ask(samples, "ur")).text || text;
          } else if (first.language && !SPOKEN_LANGUAGES.has(first.language.toLowerCase())) {
            const better = await askBothLanguages(samples);
            if (better) {
              text = better.text;
              relanguaged = `${first.language}→${better.hint}`;
            }
          }
        }
        return { text, ms: Math.round(performance.now() - started), engine: id, ...(relanguaged ? { relanguaged } : {}) };
      } catch (err) {
        const reason = err?.name === "TimeoutError" ? `timed out after ${HOSTED_TIMEOUT_MS} ms` : String(err?.message ?? err);
        console.warn(`[voice] ${id} failed (${reason}) — transcribing locally instead`);
        const result = await fallback.transcribe(samples);
        return { ...result, ms: Math.round(performance.now() - started), fallbackReason: reason.slice(0, 160) };
      }
    },
  };
}
