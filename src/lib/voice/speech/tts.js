import { createSerialQueue } from "../serial";
import { TTS } from "../config";
import { getVoice, voiceFor } from "./voices";
import { engineKeyFor } from "./engine";
import { trimSilence, withTrailingSilence } from "../audio";

/**
 * ███ THE TEXT-TO-SPEECH SEAM ███
 *
 * The call session only ever calls `synthesize({ text, voiceId })`. Which engine
 * answers is decided here — the same seam pattern as stt.js and llm.js.
 *
 * VOICE_TTS_PROVIDER: "local" (default — Kokoro and Piper via sherpa-onnx, on this
 * machine; voices.js lists every voice and which engine speaks it).
 *
 * One piece per call: the session already cuts the streamed reply into pieces
 * (sentences.js) and pipelines them — piece N+1 is synthesised while piece N plays — so a
 * per-piece API is all the streaming this needs.
 *
 * THE SILENCE AT EACH JOIN IS DECIDED HERE, not left to the engine. Every engine starts and
 * ends what it speaks with its own quiet (measured: Kokoro 50–100 ms before and 70–90 ms after
 * every piece, Piper up to 190 ms after), and every piece used to get 160 ms more on top — so a
 * sentence cut in two had ~300 ms of dead air in the middle before any synthesis delay, heard as
 * the agent stopping mid-thought. Now the engine's quiet is trimmed (audio.js trimSilence, a
 * little kept so soft sounds are not clipped) and the caller passes the pause the JOIN needs
 * (`pauseMs`, from sentences.js chunkEnding): a full one after a sentence, a short one at a
 * comma, none between two pieces of one sentence.
 *
 * @typedef {{
 *   synthesize(args: {text: string, voiceId?: string, language?: "en"|"ur", cache?: boolean, pauseMs?: number}): Promise<{samples: Float32Array, sampleRate: number, ms: number, voiceId: string, speechMs: number}>,
 *   prepare(voiceIds: string[]): Promise<void>,
 * }} TextToSpeech
 */

/**
 * @param {object} args
 * @param {object} args.engine  the loaded local speech engine (engine.js)
 * @param {Record<string, string|undefined>} [args.env]
 * @returns {TextToSpeech}
 */
export function createTextToSpeech({ engine, env = process.env }) {
  const provider = env.VOICE_TTS_PROVIDER || "local";
  if (provider !== "local") {
    throw new Error(`Unknown VOICE_TTS_PROVIDER "${provider}". Implemented: local`);
  }
  return localTextToSpeech(engine);
}

function localTextToSpeech(engine) {
  // One queue per engine instance: two callers on different voices families do not wait
  // for each other; two on the same instance take turns on it.
  const queues = new Map();
  const queueFor = (key) => {
    if (!queues.has(key)) queues.set(key, createSerialQueue());
    return queues.get(key);
  };

  /** A voice id that is unknown or not installed falls back to the language default. */
  const resolve = (voiceId, language) => {
    const voice = getVoice(voiceId);
    if (voice && engine.installedVoices.includes(voice.id)) return voice;
    return voiceFor(null, voice?.language ?? language ?? "en");
  };

  // FIXED LINES ARE SYNTHESISED ONCE. The greeting, the fillers and the apology are the
  // same words call after call (prompt.js), and the natural voice needs ~2.5 s to speak
  // a greeting from scratch — dead air at the exact moment the caller is waiting for
  // someone to pick up. Callers opt in with `cache: true`; a reply is never cached.
  // Bounded LRU: a few dozen businesses × a handful of lines each.
  const cache = new Map();

  async function synthesizeNow(voice, text, pauseMs) {
    const key = engineKeyFor(voice);
    const tts = await engine.ttsEngine(key);
    return queueFor(key)(async () => {
      const started = performance.now();
      const audio = await tts.generateAsync({ text, sid: voice.speaker, speed: TTS.speed });
      const ms = Math.round(performance.now() - started);
      const spoken = TTS.trim ? trimSilence(audio.samples, audio.sampleRate, TTS.trim).samples : audio.samples;
      return {
        samples: withTrailingSilence(spoken, audio.sampleRate, pauseMs),
        sampleRate: audio.sampleRate,
        ms,
        voiceId: voice.id,
        // How long the engine's own audio was: synthesis time ÷ this is how much slower than real
        // time this machine is speaking right now (session.js watches it).
        speechMs: Math.round((audio.samples.length / audio.sampleRate) * 1000),
      };
    });
  }

  return {
    async prepare(voiceIds) {
      await Promise.all(voiceIds.map((id) => engine.ttsEngine(engineKeyFor(resolve(id)))));
    },

    /**
     * @param {{text: string, voiceId?: string, language?: string, cache?: boolean, pauseMs?: number}} args
     *   pauseMs: silence after the piece — the pause its JOIN needs (default: a sentence's)
     */
    async synthesize({ text, voiceId, language, cache: cacheable = false, pauseMs = TTS.sentencePauseMs }) {
      const voice = resolve(voiceId, language);
      if (!cacheable) return synthesizeNow(voice, text, pauseMs);

      const key = `${voice.id}\u0000${pauseMs}\u0000${text}`;
      const started = performance.now();
      const created = !cache.has(key);
      if (created) {
        const pending = synthesizeNow(voice, text, pauseMs);
        cache.set(key, pending);
        pending.catch(() => cache.delete(key));
        if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      } else {
        // Refresh its place in the LRU order.
        const hit = cache.get(key);
        cache.delete(key);
        cache.set(key, hit);
      }
      const audio = await cache.get(key);
      // `ms` is what THIS request waited: the full synthesis for the request that created
      // the entry, ~0 for a hit (or the remainder, if it joined one still in progress).
      return { ...audio, ms: created ? audio.ms : Math.round(performance.now() - started), cached: !created };
    },
  };
}

const CACHE_ENTRIES = 256;
