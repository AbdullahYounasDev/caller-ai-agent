#!/usr/bin/env node
/**
 * HOW LOUD IS EACH ENGLISH VOICE? (npm run voice:levels) — re-measures the table behind the fast start's level
 * correction (voices.js SPEECH_LEVEL_DB) and says which entries no longer match. ZERO quota: only the speech models.
 *
 * Kokoro's own English voices differ from each other by up to 6 dB, more than Piper differs from most of them, so the
 * fast voice that opens a reply is brought to the level of the SPECIFIC voice that continues it. Run this after a
 * voice or a model changes (a new Kokoro release, another Piper voice), and paste the table it prints.
 *
 * The level is the median RMS of 30 ms frames above the noise floor, per sentence, averaged over five different
 * sentences — the same measure voice-listen.mjs uses for the step at the switch.
 *
 *   npm run voice:levels            measure and compare with the table in the code
 *   npm run voice:levels -- --tolerance=1.5   report a voice only when it is further than this many dB off (default 1)
 */
process.loadEnvFile?.(".env");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.length ? v.join("=") : true];
}));
const tolerance = Number(args.tolerance ?? 1);

const { loadLocalSpeech } = await import("@/lib/voice/speech/engine");
const { createTextToSpeech } = await import("@/lib/voice/speech/tts");
const { VOICES, SPEECH_LEVEL_DB } = await import("@/lib/voice/speech/voices");

const SENTENCES = [
  "We open Friday from two in the afternoon until eleven thirty at night.",
  "Yes, we deliver within eight kilometres of Gulberg, and it usually takes about forty-five minutes.",
  "A full chicken karahi is two thousand seven hundred Pakistani rupees.",
  "Reservations are held for fifteen minutes after the booked time, so please arrive a little early.",
  "I'm sorry, I don't have that information. Would you like me to take your details?",
];

const engine = await loadLocalSpeech();
const tts = createTextToSpeech({ engine });

const sentenceDb = (samples, rate) => {
  const frame = Math.round(rate * 0.03);
  const levels = [];
  for (let i = 0; i + frame < samples.length; i += frame) {
    let e = 0;
    for (let k = 0; k < frame; k++) e += samples[i + k] ** 2;
    const r = Math.sqrt(e / frame);
    if (r > 0.02) levels.push(r);
  }
  levels.sort((a, b) => a - b);
  return 20 * Math.log10(levels[levels.length >> 1]);
};

const measured = {};
for (const voice of VOICES.filter((v) => v.language === "en" && engine.installedVoices.includes(v.id))) {
  await tts.synthesize({ text: "Warm up.", voiceId: voice.id }).catch(() => {});
  const dbs = [];
  for (const text of SENTENCES) {
    const r = await tts.synthesize({ text, voiceId: voice.id, pauseMs: 0 });
    dbs.push(sentenceDb(r.samples, r.sampleRate));
  }
  measured[voice.id] = Math.round((dbs.reduce((a, b) => a + b, 0) / dbs.length) * 10) / 10;
}

let off = 0;
console.log("voice".padEnd(30), "measured", "in the code", "difference");
for (const [id, db] of Object.entries(measured)) {
  const known = SPEECH_LEVEL_DB[id];
  const diff = Number.isFinite(known) ? db - known : null;
  const flag = diff == null ? "NOT IN THE TABLE" : Math.abs(diff) > tolerance ? `OFF BY ${diff.toFixed(1)} dB` : "ok";
  if (flag !== "ok") off++;
  console.log(id.padEnd(30), String(db).padStart(8), String(known ?? "—").padStart(11), flag.padStart(14));
}
for (const id of Object.keys(SPEECH_LEVEL_DB)) if (!(id in measured)) console.log(id.padEnd(30), "(in the table but not installed or not an English voice)");

console.log(`\n${off ? `${off} voice(s) differ by more than ${tolerance} dB — update SPEECH_LEVEL_DB in voices.js with:` : `every installed voice is within ${tolerance} dB of the table.`}`);
if (off) {
  console.log("export const SPEECH_LEVEL_DB = {");
  for (const [id, db] of Object.entries(measured)) console.log(`  "${id}": ${db},`);
  console.log("};");
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
