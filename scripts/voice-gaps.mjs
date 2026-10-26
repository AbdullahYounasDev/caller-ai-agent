#!/usr/bin/env node
/**
 * SILENCES INSIDE THE AGENT'S REPLIES (npm run voice:gaps) — how long the caller hears nothing
 * between two pieces of one spoken reply, measured with the REAL voices on THIS machine.
 * ZERO quota: no LLM, no embedding, no database, no call.
 *
 *   npm run voice:gaps                         Kokoro (natural) English + Urdu, and Piper (fast)
 *   npm run voice:gaps -- --voice=kokoro:af_heart --slow=2
 *       --voice=ID   only this voice
 *       --slow=N     pretend this machine makes speech N× slower (a busy laptop on battery made
 *                    Kokoro ~2× slower than idle, §6.24) — shows what whole-sentence mode does
 *       --chars-per-sec=N   how fast the model "streams" the reply (default 400 ≈ a fast LLM)
 *
 * What it does: each sample reply is streamed into the real SentenceChunker at --chars-per-sec,
 * every piece is synthesised by the real engine (one after another, as on a call), and the
 * playback timeline is rebuilt — piece k starts when it is ready AND piece k−1 has finished.
 * The silence at a join is then:
 *   waiting for the piece (synthesis fell behind)  +  the quiet at the end of the previous piece
 *   +  the pause added after it  +  the quiet at the start of this one.
 * Reported twice from the same synthesis: BEFORE (the engine's own quiet kept, 160 ms after every
 * piece) and NOW (quiet trimmed, the pause chosen by where the piece ended — TTS in config.js).
 * Joins INSIDE a sentence are the ones a caller hears as the agent having finished.
 */
process.loadEnvFile?.(".env");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  })
);
const SLOW = Number(args.slow) || 1;
const CHARS_PER_SEC = Number(args["chars-per-sec"]) || 400;

const { loadLocalSpeech, engineKeyFor } = await import("@/lib/voice/speech/engine");
const { getVoice } = await import("@/lib/voice/speech/voices");
const { SentenceChunker, chunkEnding } = await import("@/lib/voice/sentences");
const { trimSilence } = await import("@/lib/voice/audio");
const { TTS } = await import("@/lib/voice/config");

const OLD_PAUSE_MS = 160;

const REPLIES = {
  en: [
    "Could you please tell me about your name and the best phone number to reach you on, so that our team can call you back today?",
    "Our clinic is open from nine in the morning until six in the evening, Monday to Saturday, and we are closed on Sundays and public holidays.",
    "Sure! A root canal treatment usually takes two visits, and the fee depends on the tooth, which our dentist will confirm after a quick check-up.",
    "We open at nine in the morning. We close at six in the evening, and on Saturdays we close at one in the afternoon.",
    "Thank you, Ahmed. I have noted your number. Our team will call you back this afternoon to confirm the appointment.",
  ],
  ur: [
    "جی، ہمارا کلینک صبح نو بجے سے شام چھ بجے تک کھلا رہتا ہے، اور اتوار کو بند ہوتا ہے۔",
    "کیا آپ مجھے اپنا نام اور فون نمبر بتا سکتے ہیں تاکہ ہماری ٹیم آج ہی آپ سے رابطہ کر سکے؟",
    "شکریہ۔ میں نے آپ کا نمبر لکھ لیا ہے۔ ہماری ٹیم آج شام آپ کو کال کرے گی تاکہ وقت کی تصدیق ہو سکے۔",
  ],
};

const engine = await loadLocalSpeech();
const voiceIds = args.voice ? [args.voice] : ["kokoro:af_heart", "kokoro:hf_alpha", "piper:en_US-lessac-medium"];

/** Measured quiet at both ends of a piece, by the same rule audio.js trims with. */
function edgeQuietMs(samples, sampleRate) {
  const trimmed = trimSilence(samples, sampleRate, { ...TTS.trim, keepLeadMs: 0, keepTailMs: 0 });
  return { lead: trimmed.leadMs, tail: trimmed.tailMs };
}

/** Stream the reply into the chunker at CHARS_PER_SEC; returns pieces with the time each became ready. */
function stream(text, wholeSentences) {
  const chunker = new SentenceChunker({ wholeSentences });
  const out = [];
  const step = 4;
  for (let i = 0; i < text.length; i += step) {
    const at = ((i + step) / CHARS_PER_SEC) * 1000;
    for (const piece of chunker.push(text.slice(i, i + step))) out.push({ text: piece, readyAt: at });
  }
  for (const piece of chunker.flush()) out.push({ text: piece, readyAt: (text.length / CHARS_PER_SEC) * 1000 });
  return out;
}

const fmt = (ms) => `${Math.round(ms)}`.padStart(5);
const summary = [];

for (const id of voiceIds) {
  const voice = getVoice(id);
  if (!voice) {
    console.log(`unknown voice ${id}`);
    continue;
  }
  const tts = await engine.ttsEngine(engineKeyFor(voice));
  console.log(`\n━━ ${id} ${SLOW !== 1 ? `(synthesis ×${SLOW})` : ""}`);

  for (const wholeSentences of [false, true]) {
    const inSentence = { before: [], now: [] };
    const atSentence = { before: [], now: [] };
    for (const reply of REPLIES[voice.language] ?? REPLIES.en) {
      const pieces = stream(reply, wholeSentences);
      // Synthesise each piece for real, one after another (as on a call: one engine, one queue).
      let engineFree = 0;
      for (const piece of pieces) {
        const started = performance.now();
        const audio = await tts.generateAsync({ text: piece.text, sid: voice.speaker, speed: TTS.speed });
        piece.synthMs = (performance.now() - started) * SLOW;
        piece.audioMs = (audio.samples.length / audio.sampleRate) * 1000;
        piece.quiet = edgeQuietMs(audio.samples, audio.sampleRate);
        piece.doneAt = Math.max(piece.readyAt, engineFree) + piece.synthMs;
        engineFree = piece.doneAt;
        piece.ending = chunkEnding(piece.text);
      }
      for (const mode of ["before", "now"]) {
        let playEnd = null;
        let prev = null;
        for (const piece of pieces) {
          const keptLead = mode === "before" ? piece.quiet.lead : Math.min(piece.quiet.lead, TTS.trim.keepLeadMs);
          const keptTail = mode === "before" ? piece.quiet.tail : Math.min(piece.quiet.tail, TTS.trim.keepTailMs);
          const pause = mode === "before" ? OLD_PAUSE_MS : piece.ending === "joined" ? TTS.joinPauseMs : piece.ending === "comma" ? TTS.commaPauseMs : TTS.sentencePauseMs;
          const length = piece.audioMs - (piece.quiet.lead - keptLead) - (piece.quiet.tail - keptTail) + pause;
          const start = playEnd == null ? piece.doneAt : Math.max(piece.doneAt, playEnd);
          if (prev) {
            // What the caller hears between the two: waiting + prev's kept tail + its pause + this one's kept lead.
            const silence = start - playEnd + prev.keptTail + prev.pause + keptLead;
            (prev.piece.ending === "sentence" ? atSentence : inSentence)[mode].push(silence);
          }
          playEnd = start + length;
          prev = { piece, keptTail, pause };
        }
      }
      if (!wholeSentences) {
        console.log(`  ${pieces.map((p) => `[${p.text}]`).join(" ")}`);
      }
    }
    const stat = (xs) => (xs.length ? `avg ${fmt(xs.reduce((a, b) => a + b, 0) / xs.length)} ms · max ${fmt(Math.max(...xs))} ms · ${xs.length} joins` : "no joins");
    const label = wholeSentences ? "whole sentences" : "pieces";
    console.log(`  ${label.padEnd(16)} INSIDE a sentence  before: ${stat(inSentence.before)}`);
    console.log(`  ${"".padEnd(16)}                    now:    ${stat(inSentence.now)}`);
    console.log(`  ${"".padEnd(16)} BETWEEN sentences  before: ${stat(atSentence.before)}`);
    console.log(`  ${"".padEnd(16)}                    now:    ${stat(atSentence.now)}`);
    summary.push({ voice: id, mode: label, inSentence, atSentence });
  }
}
console.log(`\n(streamed at ${CHARS_PER_SEC} chars/s; synthesis ×${SLOW}; "before" = engine quiet kept + ${OLD_PAUSE_MS} ms after every piece)`);
process.exit(0);
