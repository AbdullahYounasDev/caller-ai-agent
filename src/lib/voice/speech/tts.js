import { createSerialQueue } from "../serial";
import { TTS } from "../config";
import { getVoice, voiceFor } from "./voices";
import { engineKeyFor } from "./engine";

/**
 * ███ THE TEXT-TO-SPEECH SEAM ███
 *
 * The call session only ever calls `synthesize({ text, voiceId })`. Which engine
 * answers is decided here — the same seam pattern as stt.js and llm.js.
 *
 * VOICE_TTS_PROVIDER: "local" (default — Kokoro and Piper via sherpa-onnx, on this
 * machine; voices.js lists every voice and which engine speaks it).
 *
 * One sentence per call: the session already cuts the streamed reply into sentences
 * (sentences.js) and pipelines them — sentence N+1 is synthesised while sentence N
 * plays — so a per-sentence API is all the streaming this needs. Each sentence ends
 * with TTS.sentencePauseMs of silence: sentences synthesised separately and played
 * back to back otherwise run into each other, which is a large part of what makes a
 * TTS voice sound rushed and mechanical.
 *
 * @typedef {{
 *   synthesize(args: {text: string, voiceId?: string, language?: "en"|"it"|"ur"}): Promise<{samples: Float32Array, sampleRate: number, ms: number, voiceId: string}>,
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

  async function synthesizeNow(voice, text) {
    const key = engineKeyFor(voice);
    const tts = await engine.ttsEngine(key);
    return queueFor(key)(async () => {
      const started = performance.now();
      const audio = await tts.generateAsync({ text, sid: voice.speaker, speed: TTS.speed });
      return {
        samples: withTrailingSilence(audio.samples, audio.sampleRate, TTS.sentencePauseMs),
        sampleRate: audio.sampleRate,
        ms: Math.round(performance.now() - started),
        voiceId: voice.id,
      };
    });
  }

  return {
    async prepare(voiceIds) {
      await Promise.all(voiceIds.map((id) => engine.ttsEngine(engineKeyFor(resolve(id)))));
    },

    /** @param {{text: string, voiceId?: string, language?: string, cache?: boolean}} args */
    async synthesize({ text, voiceId, language, cache: cacheable = false }) {
      const voice = resolve(voiceId, language);
      if (!cacheable) return synthesizeNow(voice, text);

      const key = `${voice.id}\u0000${text}`;
      const started = performance.now();
      const created = !cache.has(key);
      if (created) {
        const pending = synthesizeNow(voice, text);
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

function withTrailingSilence(samples, sampleRate, ms) {
  const pad = Math.round((sampleRate * ms) / 1000);
  if (!pad) return samples;
  const out = new Float32Array(samples.length + pad);
  out.set(samples);
  return out;
}
