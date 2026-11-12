#!/usr/bin/env node
/**
 * LISTEN TO THE FAST START (npm run voice:listen) — renders the same replies two ways so a person can hear what
 * VOICE_FAST_FIRST_CHUNK changes, and prints the one thing that can be measured about the switch (CLAUDE.md §6.24).
 *
 *   A  the whole reply in the owner's (natural) voice — what every call sounds like today
 *   B  the FIRST piece in the matching fast voice at the natural voice's level, the rest in the natural voice
 *
 * Each reply is cut into pieces by the same SentenceChunker the call uses, with the same pause after every piece
 * (sentences.js chunkEnding, config.js TTS), and written as ONE file per reply: A, a second of silence, B. Plays in
 * any media player. ZERO quota: no model, no database — only the speech models.
 *
 *   npm run voice:listen [-- --voice=kokoro:bm_fable] [--out=./listen]
 *
 * It does NOT say which one is better. Whether a second voice in the first couple of seconds of a reply is
 * acceptable is a matter of ears, which is why the fast start is off until somebody has listened.
 */
process.loadEnvFile?.(".env");
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.length ? v.join("=") : true];
}));
const outDir = path.resolve(typeof args.out === "string" ? args.out : "listen");

const { loadLocalSpeech } = await import("@/lib/voice/speech/engine");
const { createTextToSpeech } = await import("@/lib/voice/speech/tts");
const { getVoice, fastStartVoiceFor, fastStartGainDb, VOICES } = await import("@/lib/voice/speech/voices");
const { SentenceChunker, chunkEnding } = await import("@/lib/voice/sentences");
const { TTS } = await import("@/lib/voice/config");
const { encodeWav, resample } = await import("@/lib/voice/audio");

const REPLIES = [
  ["delivery", "Yes, we deliver within eight kilometres of Gulberg three in Lahore. Average delivery takes about forty-five minutes, and on Friday or Saturday evenings it can be up to seventy-five minutes."],
  ["price", "Two thousand seven hundred Pakistani rupees. Is there anything else I can help you with?"],
  ["hours", "We open Friday from two in the afternoon until eleven thirty at night, with the kitchen taking its last order half an hour before closing."],
];
const requested = typeof args.voice === "string" ? [args.voice] : ["kokoro:af_heart", "kokoro:bm_fable"];

const engine = await loadLocalSpeech();
const tts = createTextToSpeech({ engine });
const OUT_RATE = 24_000;

const pieces = (text) => {
  const chunker = new SentenceChunker();
  const out = [];
  for (let i = 0; i < text.length; i += 4) out.push(...chunker.push(text.slice(i, i + 4)));
  return [...out, ...chunker.flush()];
};
const pauseAfter = (piece) => {
  const ending = chunkEnding(piece);
  return ending === "joined" ? TTS.joinPauseMs : ending === "comma" ? TTS.commaPauseMs : TTS.sentencePauseMs;
};
const join = (parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const toRate = (r) => (r.sampleRate === OUT_RATE ? r.samples : resample(r.samples, r.sampleRate, OUT_RATE));
/** Speech level in dBFS: the median RMS of 30 ms frames above the noise floor (the measure behind SPEECH_LEVEL_DB). */
const speechDb = (samples, rate = OUT_RATE) => {
  const frame = Math.round(rate * 0.03);
  const levels = [];
  for (let i = 0; i + frame < samples.length; i += frame) {
    let e = 0;
    for (let k = 0; k < frame; k++) e += samples[i + k] ** 2;
    const r = Math.sqrt(e / frame);
    if (r > 0.02) levels.push(r);
  }
  levels.sort((a, b) => a - b);
  return levels.length ? 20 * Math.log10(levels[levels.length >> 1]) : -120;
};
const ms = (n) => Math.round((OUT_RATE * n) / 1000);

mkdirSync(outDir, { recursive: true });
console.log(`writing to ${outDir}\n`);
for (const id of requested) {
  const natural = getVoice(id);
  const fast = fastStartVoiceFor(natural);
  if (!natural || !fast || !engine.installedVoices.includes(fast.id)) {
    console.log(`${id}: no fast partner installed — skipped`);
    continue;
  }
  const gainDb = fastStartGainDb(natural, fast);
  console.log(`${natural.id} (${natural.gender}, ${natural.accent})  →  first piece: ${fast.id}, gain ${gainDb} dB`);
  for (const [name, text] of REPLIES) {
    const list = pieces(text);
    const a = [];
    const b = [];
    const timing = { natural: 0, fast: 0 };
    for (let i = 0; i < list.length; i++) {
      const common = { text: list[i], pauseMs: pauseAfter(list[i]) };
      const nat = await tts.synthesize({ ...common, voiceId: natural.id });
      a.push(toRate(nat));
      if (i === 0) {
        const f = await tts.synthesize({ ...common, voiceId: fast.id, gainDb });
        b.push(toRate(f));
        timing.natural = nat.ms;
        timing.fast = f.ms;
      } else {
        b.push(toRate(nat));
      }
    }
    // The level step AT the switch: how much quieter (-) or louder (+) the natural voice's next piece is than the
    // fast voice's first piece, as the speech level of each (a different sentence, so it is a level, not a waveform,
    // comparison). 0 = no jump. Shown with and without the correction.
    let step = "";
    if (list.length > 1) {
      const corrected = await tts.synthesize({ text: list[0], voiceId: fast.id, gainDb, pauseMs: 0 });
      const uncorrected = await tts.synthesize({ text: list[0], voiceId: fast.id, pauseMs: 0 });
      const next = await tts.synthesize({ text: list[1], voiceId: natural.id, pauseMs: 0 });
      const nextDb = speechDb(toRate(next));
      step = `\n            level step at the switch: ${(nextDb - speechDb(toRate(corrected))).toFixed(1)} dB with the correction, ${(nextDb - speechDb(toRate(uncorrected))).toFixed(1)} dB without`;
    }
    const file = path.join(outDir, `${name}__${natural.id.replace(/[^\w]+/g, "_")}.wav`);
    writeFileSync(file, Buffer.from(encodeWav(join([...a, new Float32Array(ms(1500)), ...b]), OUT_RATE)));
    console.log(`  ${name.padEnd(9)} ${list.length} pieces · first piece made in ${timing.fast} ms (fast) vs ${timing.natural} ms (natural)${step}`);
    console.log(`            ${list[0]}`);
  }
  console.log("");
}
console.log("Each file: the reply in the natural voice, 1.5 s of silence, then the same reply with the fast start.");
process.exit(0);
