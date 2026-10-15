import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelsRoot, VAD_MODEL, STT_MODEL, KOKORO_MODEL, PIPER_VOICES } from "./models";
import { VOICES, DEFAULT_VOICES, getVoice } from "./voices";

/**
 * LOADS THE LOCAL SPEECH MODELS — once per process, at gateway start-up.
 *
 * Loading takes seconds (Parakeet ~2 s, each Kokoro language ~2.5 s); doing it per call
 * would put that in front of the greeting. So the gateway awaits loadLocalSpeech()
 * before it accepts a call: STT, the VAD config and the DEFAULT voices are ready, and any
 * other voice is loaded the first time it is needed (ttsEngine), then kept.
 *
 * sherpa-onnx is imported lazily (like the OCR stack, §6.8): only the gateway process
 * ever loads the native addon — nothing in the Next.js app imports this file.
 *
 * CPU threads: STT gets 2 by default; Kokoro gets every logical core (it is the heavy one,
 * and in a call it never runs at the same moment as STT — the caller is either talking or
 * being answered). Measured on the 4-core / 8-thread dev laptop, first chunk of a reply:
 * 2 threads 1.0–1.9 s, 4 threads 1.29 s, 6 threads 0.96 s, 8 threads 0.86 s. On a server
 * running many calls at once, lower VOICE_TTS_THREADS so calls do not fight over cores.
 */

let loading = null;

/** @returns {Promise<typeof import("sherpa-onnx-node")>} */
async function sherpa() {
  const mod = await import("sherpa-onnx-node");
  return mod.default ?? mod;
}

const HINT = "run `npm run voice:models` to download the voice models";

function requireFile(file) {
  if (!existsSync(file)) throw new Error(`Voice model file missing: ${file}\n  → ${HINT}`);
  return file;
}

/** The engine instance a voice needs: one per Kokoro language, one per Piper model. */
export function engineKeyFor(voice) {
  return voice.engine === "kokoro" ? `kokoro:${voice.language}` : `piper:${voice.model}`;
}

/** Are this voice's model files on disk? (Missing voices are offered as "not downloaded".) */
export function voiceInstalled(voice, root) {
  const dir = voice.engine === "kokoro" ? KOKORO_MODEL.dir : PIPER_VOICES[voice.model]?.dir;
  return Boolean(dir) && existsSync(path.join(root, dir));
}

/**
 * @param {Record<string, string|undefined>} [env]
 */
export function loadLocalSpeech(env = process.env) {
  if (!loading) {
    loading = load(env).catch((err) => {
      loading = null; // a failed load can be retried, not cached forever
      throw err;
    });
  }
  return loading;
}

async function load(env) {
  const root = modelsRoot(env);
  const lib = await sherpa();
  const ttsThreads = Number(env.VOICE_TTS_THREADS) || (os.availableParallelism?.() ?? 4);

  const sttDir = path.join(root, STT_MODEL.dir);
  const recognizer = await lib.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: requireFile(path.join(sttDir, STT_MODEL.files.encoder)),
        decoder: requireFile(path.join(sttDir, STT_MODEL.files.decoder)),
        joiner: requireFile(path.join(sttDir, STT_MODEL.files.joiner)),
      },
      tokens: requireFile(path.join(sttDir, STT_MODEL.files.tokens)),
      modelType: "nemo_transducer",
      numThreads: Number(env.VOICE_STT_THREADS) || 2,
      provider: "cpu",
      debug: 0,
    },
  });

  /** @type {Map<string, Promise<object>>} engine key → OfflineTts */
  const engines = new Map();

  function createEngine(key) {
    const [kind, which] = key.split(":");
    if (kind === "kokoro") {
      const dir = path.join(root, KOKORO_MODEL.dir);
      const f = KOKORO_MODEL.files;
      const lang = KOKORO_MODEL.engineLanguage[which];
      return lib.OfflineTts.createAsync({
        model: {
          kokoro: {
            model: requireFile(path.join(dir, f.model)),
            voices: requireFile(path.join(dir, f.voices)),
            tokens: requireFile(path.join(dir, f.tokens)),
            dataDir: requireFile(path.join(dir, f.data)),
            dictDir: requireFile(path.join(dir, f.dict)),
            lexicon: KOKORO_MODEL.lexicons.map((l) => requireFile(path.join(dir, l))).join(","),
            ...(lang ? { lang } : {}),
          },
          numThreads: ttsThreads,
          provider: "cpu",
          debug: 0,
        },
        maxNumSentences: 1,
      });
    }
    const voice = PIPER_VOICES[which];
    if (!voice) throw new Error(`Unknown Piper voice "${which}"`);
    const dir = path.join(root, voice.dir);
    return lib.OfflineTts.createAsync({
      model: {
        vits: {
          model: requireFile(path.join(dir, voice.model)),
          tokens: requireFile(path.join(dir, "tokens.txt")),
          dataDir: requireFile(path.join(dir, "espeak-ng-data")),
        },
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      maxNumSentences: 1,
    });
  }

  /** The engine instance for a key, loaded on first use and kept. */
  function ttsEngine(key) {
    if (!engines.has(key)) {
      const pending = createEngine(key);
      engines.set(key, pending);
      pending.catch(() => engines.delete(key)); // retryable
    }
    return engines.get(key);
  }

  // The defaults are what an unconfigured business speaks with: load them now, so a
  // first call never waits for a model.
  await Promise.all(Object.values(DEFAULT_VOICES).map((id) => ttsEngine(engineKeyFor(getVoice(id)))));

  const vadConfig = {
    sileroVad: { model: requireFile(path.join(root, VAD_MODEL.file)) },
    sampleRate: 16_000,
    numThreads: 1,
    provider: "cpu",
    debug: 0,
  };

  return {
    sherpa: lib,
    recognizer,
    ttsEngine,
    vadConfig,
    installedVoices: VOICES.filter((v) => voiceInstalled(v, root)).map((v) => v.id),
    info: {
      vad: VAD_MODEL.id,
      stt: STT_MODEL.id,
      tts: { natural: KOKORO_MODEL.id, fast: "piper" },
      runtime: `sherpa-onnx ${lib.version} / onnxruntime ${lib.onnxruntimeVersion}`,
    },
  };
}
