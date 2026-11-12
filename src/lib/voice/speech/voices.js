/**
 * THE VOICE CATALOG — every voice a business can give its agent.
 *
 * Pure data, no Node APIs: imported by the gateway (which voice to load and speak
 * with), by PUT /api/agent-config (what a business may choose) and by the console
 * (the voice picker). One list, so the three can never disagree about what exists.
 *
 * ONLY VOICES THE MODELS ACTUALLY HAVE. Every entry is a speaker inside a model we
 * download (models.js) — nothing here is aspirational.
 *
 * TWO ENGINES, and the trade-off is real (measured on a 4-core laptop CPU, §6.24):
 *   "natural" — Kokoro-82M (Apache-2.0). Human-sounding prosody, US/UK English,
 *               and Urdu, male and female. ~0.6× real time: a 3 s sentence
 *               takes ~1.8 s to synthesise, so the session keeps the first spoken
 *               chunk short (sentences.js) to hold first-audio latency down.
 *   "fast"    — Piper (VITS). ~0.15× real time, clearly more synthetic.
 *
 * URDU is spoken by Kokoro's Hindi speakers with the espeak-ng Urdu phonemizer
 * (engine language "ur"): spoken Urdu and Hindi are one language at the sound level,
 * and the phonemizer reads Urdu script directly. Checked by transcribing the output
 * with an independent model: word-for-word correct, identified as Pakistani Urdu.
 * There is no permissively licensed Urdu-native voice — Meta's MMS Urdu model is
 * CC-BY-NC (non-commercial) and must not be used.
 *
 * `quality` is the upstream model's own grade for that speaker (Kokoro VOICES.md);
 * the console sorts by it so the best voice in each group is the first one offered.
 */

/** The languages a call can be spoken in — exactly agent_configs.replyLanguage's values. */
export const SPOKEN_LANGUAGES = ["en", "ur"];

/**
 * @typedef {object} Voice
 * @property {string} id         stable id stored in agent_configs.voices — "kokoro:af_heart"
 * @property {"kokoro"|"piper"} engine
 * @property {"en"|"ur"} language
 * @property {string} accent     shown in the picker: "US" | "UK" | "PK"
 * @property {"female"|"male"} gender
 * @property {string} name       the speaker's display name
 * @property {"natural"|"fast"} tier
 * @property {number} speaker    speaker id inside the model (Kokoro sid; 0 for single-speaker Piper)
 * @property {string} [model]    for Piper: which voice model (models.js PIPER_VOICES key)
 * @property {string} grade      upstream quality grade, A best
 */

const kokoro = (language, accent, gender, name, speaker, grade) => ({
  id: `kokoro:${name.toLowerCase().replace(/\s+/g, "_")}`,
  engine: "kokoro",
  language,
  accent,
  gender,
  name: name.split("_")[1][0].toUpperCase() + name.split("_")[1].slice(1),
  tier: "natural",
  speaker,
  grade,
});

const piper = (language, accent, gender, name, model, grade) => ({
  id: `piper:${model}`,
  engine: "piper",
  language,
  accent,
  gender,
  name,
  tier: "fast",
  speaker: 0,
  model,
  grade,
});

/** @type {Voice[]} Speaker ids are the model's own table (kokoro-multi-lang-v1_0 metadata). */
export const VOICES = [
  // ── English, natural ─────────────────────────────────────────────────────
  kokoro("en", "US", "female", "af_heart", 3, "A"),
  kokoro("en", "US", "female", "af_bella", 2, "A-"),
  kokoro("en", "US", "female", "af_nicole", 6, "B-"),
  kokoro("en", "US", "female", "af_aoede", 1, "C+"),
  kokoro("en", "US", "female", "af_kore", 5, "C+"),
  kokoro("en", "US", "female", "af_sarah", 9, "C+"),
  kokoro("en", "US", "male", "am_michael", 16, "C+"),
  kokoro("en", "US", "male", "am_fenrir", 14, "C+"),
  kokoro("en", "US", "male", "am_puck", 18, "C+"),
  kokoro("en", "US", "male", "am_echo", 12, "D"),
  kokoro("en", "UK", "female", "bf_emma", 21, "B-"),
  kokoro("en", "UK", "female", "bf_isabella", 22, "C"),
  kokoro("en", "UK", "male", "bm_george", 26, "C"),
  kokoro("en", "UK", "male", "bm_fable", 25, "C"),
  // ── Urdu, natural (Kokoro's Hindi speakers + the Urdu phonemizer, see above) ─
  kokoro("ur", "PK", "female", "hf_alpha", 31, "C"),
  kokoro("ur", "PK", "female", "hf_beta", 32, "C"),
  kokoro("ur", "PK", "male", "hm_omega", 33, "C"),
  kokoro("ur", "PK", "male", "hm_psi", 34, "C"),
  // ── fast (Piper) ─────────────────────────────────────────────────────────
  piper("en", "US", "female", "Lessac", "en_US-lessac-medium", "B"),
  piper("en", "US", "male", "Ryan", "en_US-ryan-medium", "B"),
];

/**
 * What a voice says when a business previews it in the console — one neutral line per
 * language, no digits (so the preview also shows how the voice paces a plain sentence).
 * Urdu avoids first-person verbs, which would have to agree with the voice's gender.
 */
export const PREVIEW_TEXT = {
  en: "Hello, thanks for calling. I can help you with our prices, opening hours and services.",
  ur: "السلام علیکم، کال کرنے کا شکریہ۔ آپ ہم سے قیمتوں، اوقات اور خدمات کے بارے میں پوچھ سکتے ہیں۔",
};

/** What a business gets until it picks something: the best-graded natural voice. */
export const DEFAULT_VOICES = { en: "kokoro:af_heart", ur: "kokoro:hf_alpha" };

const BY_ID = new Map(VOICES.map((v) => [v.id, v]));

/** @param {string} id @returns {Voice|null} */
export function getVoice(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * The voice a call speaks a given language with: the business's choice if it is a
 * real voice FOR THAT LANGUAGE, else the default. Never throws, never returns a
 * voice of the wrong language — a stale or hand-edited config degrades to the
 * default instead of reading Urdu with an English voice.
 *
 * @param {Record<string,string>|null|undefined} chosen  agent_configs.voices
 * @param {"en"|"ur"} language
 * @returns {Voice}
 */
export function voiceFor(chosen, language) {
  const lang = SPOKEN_LANGUAGES.includes(language) ? language : "en";
  const pick = getVoice(chosen?.[lang]);
  return pick && pick.language === lang ? pick : getVoice(DEFAULT_VOICES[lang]);
}

/**
 * Validate a `voices` patch for agent_configs: { [language]: voiceId }.
 * @returns {string[]} problems, as "key:detail" codes the route translates
 */
export function voiceSelectionProblems(voices) {
  if (!voices || typeof voices !== "object" || Array.isArray(voices)) return ["invalid"];
  const problems = [];
  for (const [language, id] of Object.entries(voices)) {
    if (!SPOKEN_LANGUAGES.includes(language)) problems.push(`language:${language}`);
    else if (getVoice(id)?.language !== language) problems.push(`voice:${String(id)}`);
  }
  return problems;
}

// ── THE FAST START: the first piece of a reply in a fast voice (CLAUDE.md §6.24) ─────────────────
//
// The natural voice needs ~40 ms per character, so a 45-character first chunk takes 1.5–2.2 s to make
// before the caller hears anything; Piper makes it in 0.3–0.55 s (measured 2026-11-12, warm, mains
// power). With VOICE_FAST_FIRST_CHUNK on, the first piece of an English reply is spoken by the Piper
// voice that matches the agent's voice, and the rest by the voice the owner chose. Two engines in one
// reply are only acceptable if they do not jump, so the match is chosen on what can be measured:
//   - GENDER (the agent's gender is its voice's, and the prompt says so): a female Kokoro voice gets the
//     female Piper voice. Pitch measured: 189 vs 190 Hz (female), 114 vs 130 Hz (male).
//   - LOUDNESS: Piper is not at the same level as every Kokoro voice, and Kokoro's own voices differ by
//     up to 6 dB, so a gain is worked out PER PAIR from the table below.
// Urdu has no fast voice, so an Urdu reply is untouched.

/**
 * Median speech level of each English voice, dBFS (RMS of 30 ms frames above the noise floor, mean of the
 * medians over five different sentences). MEASURED on 2026-11-12 with `npm run voice:levels`; measure it
 * again when a voice or a model changes. A voice missing here simply gets no gain correction.
 */
export const SPEECH_LEVEL_DB = {
  "kokoro:af_heart": -23.7,
  "kokoro:af_bella": -23.5,
  "kokoro:af_nicole": -23.8,
  "kokoro:af_aoede": -19.4,
  "kokoro:af_kore": -20.1,
  "kokoro:af_sarah": -22.1,
  "kokoro:am_michael": -25.4,
  "kokoro:am_fenrir": -21.0,
  "kokoro:am_puck": -21.1,
  "kokoro:am_echo": -23.4,
  "kokoro:bf_emma": -22.1,
  "kokoro:bf_isabella": -21.0,
  "kokoro:bm_george": -21.4,
  "kokoro:bm_fable": -25.0,
  "piper:en_US-lessac-medium": -22.0,
  "piper:en_US-ryan-medium": -21.0,
};

/** The most a level correction may move a voice — a wrong entry must not turn a piece into a shout. */
const MAX_FAST_START_GAIN_DB = 6;

/**
 * The fast voice that speaks the first piece of a reply for a NATURAL English voice: the Piper voice of
 * the same gender. null when there is none — an Urdu voice, a voice that is already fast, an unknown id.
 *
 * @param {Voice|null|undefined} voice the voice the owner chose for English
 * @returns {Voice|null}
 */
export function fastStartVoiceFor(voice) {
  if (!voice || voice.engine !== "kokoro" || voice.language !== "en") return null;
  return VOICES.find((v) => v.engine === "piper" && v.language === "en" && v.gender === voice.gender) ?? null;
}

/** Every voice that can be a fast start, so the gateway can load them before the first call. */
export const FAST_START_VOICE_IDS = VOICES.filter((v) => v.engine === "piper" && v.language === "en").map((v) => v.id);

/**
 * The gain, in dB, that brings the fast voice to the level of the natural voice it opens for. 0 when
 * either level is unknown; never more than ±6 dB.
 *
 * @param {Voice} natural
 * @param {Voice} fast
 */
export function fastStartGainDb(natural, fast) {
  const to = SPEECH_LEVEL_DB[natural?.id];
  const from = SPEECH_LEVEL_DB[fast?.id];
  if (!Number.isFinite(to) || !Number.isFinite(from)) return 0;
  const gain = Math.round((to - from) * 10) / 10;
  return Math.max(-MAX_FAST_START_GAIN_DB, Math.min(MAX_FAST_START_GAIN_DB, gain));
}
