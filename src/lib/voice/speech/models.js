import path from "node:path";

/**
 * THE VOICE MODEL MANIFEST — every speech model the gateway loads, where it comes
 * from and where it lives on disk. One file, so the downloader
 * (scripts/voice-models.mjs) and the runtime loader (engine.js) can never disagree
 * about a path.
 *
 * All three run LOCALLY through sherpa-onnx (onnxruntime on the CPU): no API key,
 * no per-minute cost, no quota, and no network hop on the hot path of a turn. They
 * are behind the stt.js / tts.js seams, so a hosted provider (or a dedicated model
 * server, §9.2) can replace any one of them without touching the call session.
 *
 * Sources are the official k2-fsa/sherpa-onnx GitHub releases. The files are large
 * (≈620 MB together) and are NEVER committed: they live under VOICE_MODELS_DIR
 * (default ./models/voice, gitignored) and `npm run voice:models` fetches them.
 */

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

/** Root folder for every voice model. Overridable so a server can keep them on a separate disk. */
export function modelsRoot(env = process.env) {
  return path.resolve(env.VOICE_MODELS_DIR || path.join("models", "voice"));
}

/**
 * VAD — Silero. Decides when the caller starts and stops talking, which is both the
 * end-of-turn signal and the barge-in signal. 0.6 MB, runs on every 32 ms of audio.
 */
export const VAD_MODEL = {
  id: "silero-vad",
  url: `${RELEASES}/asr-models/silero_vad.onnx`,
  file: "silero_vad.onnx",
};

/**
 * STT — NVIDIA Parakeet TDT 0.6B v3, int8. 25 European languages including English,
 * with punctuation — and NOT Urdu, which is why Urdu callers go to the hosted recogniser
 * (speech/stt.js). Non-streaming: it transcribes one whole utterance once the VAD says
 * the caller has stopped, which on a modern CPU costs a fraction of the utterance's length.
 */
export const STT_MODEL = {
  id: "parakeet-tdt-0.6b-v3-int8",
  url: `${RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
  dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  files: {
    encoder: "encoder.int8.onnx",
    decoder: "decoder.int8.onnx",
    joiner: "joiner.int8.onnx",
    tokens: "tokens.txt",
  },
};

/**
 * TTS, "natural" tier — Kokoro-82M v1.0, multi-language, 54 speakers (Apache-2.0).
 *
 * The fp32 build, NOT the int8 one, deliberately: measured on this project's 4-core
 * laptop CPU, int8 ran at 1.3–1.6× real time (slower than speech — unusable live) and
 * fp32 at ~0.6×. int8 kernels are not faster on every CPU; measure before switching.
 * One OfflineTts instance per engine language ("en", "ur"), because the
 * phonemizer language is fixed per instance in sherpa-onnx.
 */
export const KOKORO_MODEL = {
  id: "kokoro-multi-lang-v1_0",
  url: `${RELEASES}/tts-models/kokoro-multi-lang-v1_0.tar.bz2`,
  dir: "kokoro-multi-lang-v1_0",
  files: { model: "model.onnx", voices: "voices.bin", tokens: "tokens.txt", data: "espeak-ng-data", dict: "dict" },
  /** English words come from Kokoro's own US-English lexicon; anything else goes through espeak-ng. */
  lexicons: ["lexicon-us-en.txt", "lexicon-zh.txt"],
  /** Engine language passed to sherpa-onnx per spoken language. Urdu = espeak-ng "ur". */
  engineLanguage: { en: null, ur: "ur" },
};

/**
 * TTS, "fast" tier — Piper (VITS) voices, one model per voice. Keys are the ids used
 * in voices.js (`piper:<key>`).
 */
export const PIPER_VOICES = Object.fromEntries(
  ["en_US-lessac-medium", "en_US-ryan-medium"].map((name) => [
    name,
    {
      id: `piper-${name}`,
      url: `${RELEASES}/tts-models/vits-piper-${name}.tar.bz2`,
      dir: `vits-piper-${name}`,
      model: `${name}.onnx`,
    },
  ])
);

/** Everything the downloader fetches, in one list. */
export function allModelDownloads() {
  return [
    { id: VAD_MODEL.id, url: VAD_MODEL.url, target: VAD_MODEL.file, archive: false },
    { id: STT_MODEL.id, url: STT_MODEL.url, target: STT_MODEL.dir, archive: true },
    { id: KOKORO_MODEL.id, url: KOKORO_MODEL.url, target: KOKORO_MODEL.dir, archive: true },
    ...Object.values(PIPER_VOICES).map((v) => ({ id: v.id, url: v.url, target: v.dir, archive: true })),
  ];
}
