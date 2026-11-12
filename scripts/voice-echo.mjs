#!/usr/bin/env node
/**
 * DOES THE ECHO GUARD TELL THE AGENT'S OWN VOICE FROM A PERSON? (npm run voice:echo) — ZERO quota: only the
 * speech models. The guard (src/lib/voice/echo-guard.js) is the one that runs in the gateway; this drives it
 * exactly the way the call session does, with the REAL voice detector, over a simulated loop-back:
 *
 *   the agent's real synthesised reply  →  a room (a direct path + a reverberant tail, a delay, a loss)  →
 *   the microphone (+ room noise)  →  Silero VAD  →  "would the agent have been interrupted?"
 *
 * Three situations, many random rooms each (delay 40–700 ms, loss 6–30 dB, reverb 0.1–0.5 s, two agent
 * voices, different sentences):
 *   echo only      the agent talks, nobody else: every interruption is FALSE; the guard should stop them
 *   talk over      a real person (another voice) starts talking over the agent: it MUST still be interrupted
 *   headphones     no echo at all, a person talks over the agent: must be interrupted as before
 * "without the guard" is today's rule: interrupt as soon as the detector has heard 350 ms of speech.
 *
 * ⚠️ What this is not: a real room and a real speakerphone. The synthetic room has the properties that matter
 * for the guard (delay, loss, smearing, noise) but real ones add distortion and a moving path. The numbers set
 * the guard's thresholds (config.js ECHO_GUARD); real calls are what confirms them.
 *
 *   npm run voice:echo                   all three, 12 rooms each
 *   npm run voice:echo -- --rooms=30 --seed=7 --verbose
 */
process.loadEnvFile?.(".env");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.length ? v.join("=") : true];
}));
const ROOMS = Number(args.rooms ?? 12);
const verbose = Boolean(args.verbose);
let seed = Number(args.seed ?? 1);
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const between = (a, b) => a + (b - a) * rand();

const { loadLocalSpeech } = await import("@/lib/voice/speech/engine");
const { createTextToSpeech } = await import("@/lib/voice/speech/tts");
const { VoiceActivity } = await import("@/lib/voice/speech/vad");
const { EchoGuard } = await import("@/lib/voice/echo-guard");
const { BARGE_IN, ECHO_GUARD, SAMPLE_RATE } = await import("@/lib/voice/config");

const engine = await loadLocalSpeech();
const tts = createTextToSpeech({ engine });
const resample = (s, from, to) => (from === to ? s : new engine.sherpa.LinearResampler(from, to).flush(s));

const AGENT_REPLIES = [
  "We open Friday from two in the afternoon until eleven thirty at night. Yes, we deliver within eight kilometres, and it usually takes about forty-five minutes.",
  "A full chicken karahi is two thousand seven hundred Pakistani rupees, and a half is fifteen hundred. Would you like me to take your order?",
  "Reservations are held for fifteen minutes after the booked time, so please arrive a little early. Is there anything else I can help you with?",
  "I'm sorry, I don't have that information to hand. I can take your name and number, and someone from the team will call you back today.",
];
const HUMAN_LINES = [
  "Sorry, can I just ask something before you go on, I need the address of the Gulberg branch please.",
  "No wait, that's not what I wanted, I'd like to cancel the order I made yesterday afternoon.",
  "Hold on a second, how much did you say that was, I didn't catch the price.",
];
const AGENT_VOICES = ["kokoro:af_heart", "kokoro:bm_fable", "piper:en_US-lessac-medium", "piper:en_US-ryan-medium"]
  .filter((id) => engine.installedVoices.includes(id));
const HUMAN_VOICES = ["kokoro:am_adam", "kokoro:af_bella", "kokoro:bf_emma", "kokoro:bm_george", "piper:en_US-ryan-medium", "piper:en_US-lessac-medium"]
  .filter((id) => engine.installedVoices.includes(id));
if (!AGENT_VOICES.length || !HUMAN_VOICES.length) {
  console.error("No English voices installed — run `npm run voice:models` first.");
  process.exit(2);
}

const cache = new Map();
async function speak(text, voiceId) {
  const key = `${voiceId}|${text}`;
  if (!cache.has(key)) {
    const r = await tts.synthesize({ text, voiceId, pauseMs: 0 });
    cache.set(key, resample(r.samples, r.sampleRate, SAMPLE_RATE));
  }
  return cache.get(key);
}

const rmsDb = (x) => {
  let e = 0;
  for (const v of x) e += v * v;
  return 10 * Math.log10(e / Math.max(1, x.length) + 1e-12);
};

/** A room: delay + a direct path + sparse exponentially decaying reflections; scaled to the loss. */
function throughRoom(signal, { delayMs, lossDb, rt60Ms }) {
  const delay = Math.round((delayMs / 1000) * SAMPLE_RATE);
  const taps = [{ at: 0, a: 1 }];
  const tail = Math.round((rt60Ms / 1000) * SAMPLE_RATE);
  for (let i = 0; i < 40; i++) {
    const at = Math.round(between(0.004, 1) * tail);
    // −60 dB at rt60: amplitude e^(−6.9 t / rt60), with random sign and a share of the direct energy
    taps.push({ at, a: (rand() < 0.5 ? -1 : 1) * 0.35 * Math.exp((-6.9 * at) / tail) * rand() });
  }
  const out = new Float32Array(signal.length + delay + tail + 1);
  for (const { at, a } of taps) for (let i = 0; i < signal.length; i++) out[i + delay + at] += a * signal[i];
  const g = Math.pow(10, -lossDb / 20);
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}


const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * A call's worth of audio for one trial: the agent's FIRST utterance (the greeting: the echo path is unknown, the
 * guard's cold start), a pause, then a REPLY (the path has been learned by then). Replies are where a call spends its
 * time, so the replies decide; the greeting is reported on its own.
 */
async function buildTrial(kind) {
  const agentVoice = AGENT_VOICES[Math.floor(rand() * AGENT_VOICES.length)];
  const first = Math.floor(rand() * AGENT_REPLIES.length);
  const a = await speak(AGENT_REPLIES[first], agentVoice);
  const b = await speak(AGENT_REPLIES[(first + 1 + Math.floor(rand() * (AGENT_REPLIES.length - 1))) % AGENT_REPLIES.length], agentVoice);
  const gap = Math.round(1.2 * SAMPLE_RATE);
  const lead = Math.round(between(0.4, 0.9) * SAMPLE_RATE); // quiet before the agent starts
  const warmFrom = lead + a.length + gap;
  const room = { delayMs: between(40, 700), lossDb: between(6, 30), rt60Ms: between(100, 500) };
  const human = kind === "echo" ? null : await speak(HUMAN_LINES[Math.floor(rand() * HUMAN_LINES.length)], HUMAN_VOICES[Math.floor(rand() * HUMAN_VOICES.length)]);
  const humanOnset = kind === "echo" ? null : warmFrom + Math.round(between(1.0, 2.2) * SAMPLE_RATE);
  // When a person interrupts, the gateway stops the agent's audio (barge-in): ~0.75 s after they begin
  // (the detector's own time + 350 ms), so the echo ends there, smeared by the room.
  const cutAt = humanOnset == null ? null : humanOnset + Math.round(0.75 * SAMPLE_RATE);
  const bEnd = warmFrom + b.length;
  // + time for the detector to close, after the agent AND after the person
  const total = Math.max(bEnd, humanOnset == null ? 0 : humanOnset + human.length) + Math.round(2 * SAMPLE_RATE);
  const mic = new Float32Array(total);
  if (kind !== "headphones") {
    const bHeard = cutAt == null ? b : b.slice(0, Math.max(0, cutAt - warmFrom));
    if (cutAt != null) for (let i = 0; i < 320 && i < bHeard.length; i++) bHeard[bHeard.length - 1 - i] *= i / 320;
    const echo = throughRoom(concat(a, new Float32Array(gap), bHeard), room);
    for (let i = 0; i < echo.length && lead + i < total; i++) mic[lead + i] += echo[i];
  }
  // The room: steady noise at −52…−44 dBFS
  const noise = Math.pow(10, between(-52, -44) / 20);
  for (let i = 0; i < total; i++) mic[i] += (rand() * 2 - 1) * noise * 1.7;
  if (kind !== "echo") {
    // A person talking to a phone or laptop microphone: −32…−20 dBFS rms (the agent's own voice is about −22 at the
    // source, so the echo is 6–30 dB below that). Their level does not depend on the room's echo.
    const level = between(-32, -20);
    const gain = Math.pow(10, (level - rmsDb(human)) / 20);
    for (let i = 0; i < human.length && humanOnset + i < total; i++) mic[humanOnset + i] += human[i] * gain;
  }
  for (let i = 0; i < total; i++) mic[i] = Math.max(-1, Math.min(1, mic[i]));
  const ms = (s) => (s / SAMPLE_RATE) * 1000;
  return {
    mic, room, agentVoice, cutAt, humanStart: humanOnset,
    pieces: [{ samples: a, atMs: ms(lead) }, { samples: b, atMs: ms(warmFrom) }],
    // when the session would consider the agent audible (its estimate of the audio + the playback slack)
    audible: [[ms(lead), ms(lead + a.length) + 250], [ms(warmFrom), ms(cutAt ?? bEnd) + 250]],
    warmFromMs: ms(warmFrom),
  };
}

/** Drive the REAL detector and the guard like the session does. Returns what each rule would have done. */
function run(trial) {
  const vad = new VoiceActivity({ sherpa: engine.sherpa, config: engine.vadConfig });
  const guard = new EchoGuard();
  for (const p of trial.pieces) guard.pushReference(p.samples, SAMPLE_RATE, p.atMs);

  const CHUNK = 320; // 20 ms
  // The first interruption in each of the two utterances, today's rule and with the guard.
  const barge = { old: [null, null], new: [null, null] };
  const verdicts = [null, null];
  let suppressed = 0;
  let cut = false;
  const utterances = [];
  for (let at = 0; at + CHUNK <= trial.mic.length; at += CHUNK) {
    const chunk = trial.mic.subarray(at, at + CHUNK);
    const arrivalMs = ((at + CHUNK) / SAMPLE_RATE) * 1000 + between(0, 12);
    guard.pushCaller(chunk, arrivalMs);
    if (trial.cutAt != null && at + CHUNK >= trial.cutAt && !cut) {
      cut = true;
      guard.cutReference((trial.cutAt / SAMPLE_RATE) * 1000);
    }
    for (const ev of vad.push(chunk)) {
      const nowMs = ((at + CHUNK) / SAMPLE_RATE) * 1000;
      const slot = trial.audible.findIndex(([from, to]) => nowMs >= from && nowMs < to);
      if (ev.type === "start") guard.speechStarted();
      if (ev.type === "ongoing" && slot >= 0 && ev.speechMs >= BARGE_IN.minSpeechMs) {
        if (barge.old[slot] == null) barge.old[slot] = nowMs;
        if (barge.new[slot] == null) {
          const { own, verdict: v0 } = guard.bargeCheck(guard.position - Math.round((ECHO_GUARD.bargeWindowMs / 1000) * SAMPLE_RATE), guard.position, nowMs);
          const verdict = { ...v0, echo: own };
          if (args.trace && slot === (args.slot0 ? 0 : 1)) console.log(`   t=${Math.round(nowMs)} ${verdict.echo ? "ECHO" : "NOT "} ${verdict.reason} ρ${verdict.correlation ?? "-"} lag${verdict.lagMs ?? "-"} path=${guard.path ? guard.path.lag * 10 : "-"}`);
          if (verdict.echo) suppressed++;
          else {
            barge.new[slot] = nowMs;
            verdicts[slot] = verdict;
          }
        }
      } else if (ev.type === "utterance") {
        const verdict = guard.assessSpan(ev.startSample ?? 0, ev.endSample ?? guard.position);
        utterances.push({ startMs: (ev.startSample / SAMPLE_RATE) * 1000, durationMs: ev.durationMs, echo: verdict.echo, verdict });
      }
    }
  }
  return { barge, verdicts, suppressed, utterances, pathLearned: guard.path != null };
}

const summary = { echo: [], "talk-over": [], headphones: [] };
const KINDS = String(args.kinds ?? "echo,talk-over,headphones").split(",");
for (const kind of KINDS) {
  const rows = [];
  for (let i = 0; i < ROOMS; i++) {
    const trial = await buildTrial(kind);
    const r = run(trial);
    const humanMs = trial.humanStart == null ? null : (trial.humanStart / SAMPLE_RATE) * 1000;
    const keptUtterances = r.utterances.filter((u) => !u.echo);
    rows.push({ trial, r, humanMs, keptUtterances });
    const lost = humanMs != null && kind === "talk-over" && !keptUtterances.some((u) => u.startMs + u.durationMs >= humanMs);
    if (verbose || lost) {
      const f = (x) => (x == null ? "-" : Math.round(x));
      const v = r.verdicts[1];
      console.log(
        `${lost ? "LOST HUMAN SPEECH → " : ""}${kind.padEnd(10)} #${i} room ${Math.round(trial.room.delayMs)}ms/${trial.room.lossDb.toFixed(0)}dB/rt${Math.round(trial.room.rt60Ms)} ` +
          `greeting old=${f(r.barge.old[0])} new=${f(r.barge.new[0])} | reply old=${f(r.barge.old[1])} new=${f(r.barge.new[1])} human@${humanMs == null ? "-" : Math.round(humanMs)} ` +
          `suppressed=${r.suppressed} path=${r.pathLearned ? "yes" : "no"}${v ? ` [${v.reason} ρ${v.correlation ?? "-"}]` : ""}  ` +
          `utterances ${r.utterances.map((u) => `${Math.round(u.startMs)}+${u.durationMs}${u.echo ? "E" : "H"}`).join(" ")}`
      );
    }
  }
  summary[kind] = rows;
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const med = (a) => (a.length ? Math.round(a.sort((x, y) => x - y)[a.length >> 1]) : "-");
console.log("\n=== echo only: the agent talks, nobody else — every interruption is FALSE ===");
{
  const rows = summary.echo;
  const n = rows.length;
  const count = (rule, slot) => rows.filter((x) => x.r.barge[rule][slot] != null).length;
  console.log(`the greeting (cold start, echo path unknown)   interrupted without the guard ${count("old", 0)}/${n} (${pct(count("old", 0), n)})   with ${count("new", 0)}/${n} (${pct(count("new", 0), n)})`);
  console.log(`a reply (after the greeting)                    interrupted without the guard ${count("old", 1)}/${n} (${pct(count("old", 1), n)})   with ${count("new", 1)}/${n} (${pct(count("new", 1), n)})`);
  const strayOld = rows.reduce((k, x) => k + x.r.utterances.length, 0);
  const strayNew = rows.reduce((k, x) => k + x.keptUtterances.length, 0);
  console.log(`stray "utterances" (echo sent to the recogniser as a question)   without ${strayOld}   with ${strayNew}`);
  console.log(`echo path learned by the end: ${rows.filter((x) => x.r.pathLearned).length}/${n}`);
}
console.log("\n=== a person talks over a REPLY (must still interrupt) ===");
{
  const rows = summary["talk-over"];
  const n = rows.length;
  const hit = (rule) => rows.filter((x) => x.r.barge[rule][1] != null && x.r.barge[rule][1] >= x.humanMs).length;
  const early = rows.filter((x) => x.r.barge.new[1] != null && x.r.barge.new[1] < x.humanMs).length;
  const delays = rows.filter((x) => x.r.barge.new[1] != null && x.r.barge.new[1] >= x.humanMs).map((x) => x.r.barge.new[1] - x.humanMs);
  const delaysOld = rows.filter((x) => x.r.barge.old[1] != null && x.r.barge.old[1] >= x.humanMs).map((x) => x.r.barge.old[1] - x.humanMs);
  console.log(`interrupted by the person   without ${hit("old")}/${n}   with ${hit("new")}/${n}   (${early} cut by the echo BEFORE the person spoke)`);
  console.log(`delay from the person's first word   median without ${med(delaysOld)} ms   with ${med(delays)} ms   slowest with ${delays.length ? Math.round(Math.max(...delays)) : "-"} ms`);
  const kept = rows.filter((x) => x.keptUtterances.some((u) => u.startMs + u.durationMs >= x.humanMs)).length;
  console.log(`the person's speech reaches the recogniser (not dropped as echo)   ${kept}/${n}`);
}
console.log("\n=== headphones: no echo at all, a person talks over a reply (must be exactly as before) ===");
{
  const rows = summary.headphones;
  const n = rows.length;
  const hit = (rule) => rows.filter((x) => x.r.barge[rule][1] != null).length;
  const delays = rows.filter((x) => x.r.barge.new[1] != null).map((x) => x.r.barge.new[1] - x.humanMs);
  const delaysOld = rows.filter((x) => x.r.barge.old[1] != null).map((x) => x.r.barge.old[1] - x.humanMs);
  console.log(`interrupted   without ${hit("old")}/${n}   with ${hit("new")}/${n}    delay median ${med(delaysOld)} ms → ${med(delays)} ms`);
  console.log(`the person's speech reaches the recogniser   ${rows.filter((x) => x.keptUtterances.length > 0).length}/${n}`);
  console.log(`false echo paths learned: ${rows.filter((x) => x.r.pathLearned).length}/${n}`);
}
process.exit(0);
