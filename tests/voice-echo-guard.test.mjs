import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { EchoGuard } from "@/lib/voice/echo-guard";
import { ECHO_GUARD, SAMPLE_RATE, echoGuardEnabled } from "@/lib/voice/config";

/**
 * The echo guard with synthetic signals: no models. "Speech" here is noise shaped into syllables and words
 * (bursts of 80–220 ms with gaps), which is all the guard looks at — its loudness pattern. The real voices and a
 * real detector are in `npm run voice:echo`; these tests pin the rules.
 */

function rngFor(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A few seconds of speech-like audio at 16 kHz. */
function speechLike(seed, seconds, { level = 1 } = {}) {
  const rand = rngFor(seed);
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let at = 0;
  let inSentence = 0;
  while (at < out.length) {
    const burst = Math.round((0.08 + rand() * 0.14) * SAMPLE_RATE);
    const amp = (0.06 + rand() * 0.3) * level;
    for (let i = 0; i < burst && at + i < out.length; i++) {
      out[at + i] = Math.sin((Math.PI * i) / burst) * amp * (rand() * 2 - 1);
    }
    at += burst;
    inSentence++;
    const gap = inSentence % 8 === 0 ? 0.25 + rand() * 0.15 : 0.02 + rand() * 0.1;
    at += Math.round(gap * SAMPLE_RATE);
  }
  return out;
}

/** What a microphone hears of `signal` played by a speaker: delayed, quieter, with a short reverberant tail. */
function echoOf(signal, { delayMs, gain }) {
  const delay = Math.round((delayMs / 1000) * SAMPLE_RATE);
  const out = new Float32Array(signal.length + delay + 3000);
  const taps = [[0, 1], [480, 0.5], [1440, 0.3], [2560, 0.15]];
  for (const [at, a] of taps) for (let i = 0; i < signal.length; i++) out[i + delay + at] += signal[i] * a * gain;
  return out;
}

function noise(rand, n, level) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * level;
  return out;
}

const mix = (n, ...parts) => {
  const out = new Float32Array(n);
  for (const { signal, at = 0 } of parts) for (let i = 0; i < signal.length && at + i < n; i++) out[at + i] += signal[i];
  return out;
};

/** Play `agent` from `startMs`, feed the microphone `mic` in 20 ms chunks. Returns the guard. */
function run({ agent, mic, startMs = 500, upTo = mic.length, sampleRate = SAMPLE_RATE, arrivalOffsetMs = 0 }) {
  const guard = new EchoGuard();
  if (agent) guard.pushReference(agent, sampleRate, startMs);
  for (let at = 0; at + 320 <= upTo; at += 320) {
    guard.pushCaller(mic.subarray(at, at + 320), ((at + 320) / SAMPLE_RATE) * 1000 + arrivalOffsetMs);
    if (at % 3200 === 0) probe(guard);
  }
  return guard;
}

/** The session asks a question every time the detector reports ongoing speech; the guard learns the path when asked. */
const probe = (guard) => guard.assess(guard.position - Math.round(0.6 * SAMPLE_RATE), guard.position);

const lastMs = (guard, ms) => guard.assess(guard.position - Math.round((ms / 1000) * SAMPLE_RATE), guard.position);

describe("EchoGuard", () => {
  test("the agent's own voice coming back is recognised, at the right delay, once its path is learned", () => {
    const agent = speechLike(1, 6);
    const rand = rngFor(2);
    const n = Math.round(9 * SAMPLE_RATE);
    const mic = mix(n, { signal: echoOf(agent, { delayMs: 300, gain: 0.12 }), at: Math.round(0.5 * SAMPLE_RATE) }, { signal: noise(rand, n, 0.004) });
    const guard = run({ agent, mic, upTo: Math.round(4 * SAMPLE_RATE) });
    const verdict = lastMs(guard, ECHO_GUARD.bargeWindowMs);
    assert.equal(verdict.echo, true, JSON.stringify(verdict));
    assert.ok(Math.abs(verdict.lagMs - 300) <= 40, `delay found: ${verdict.lagMs}`);
  });

  test("it works whatever the delay, the loss and the room (a table of echoes)", () => {
    for (const [seed, delayMs, gain] of [[3, 60, 0.3], [4, 180, 0.08], [5, 450, 0.1], [6, 700, 0.15]]) {
      const agent = speechLike(seed, 6);
      const n = Math.round(9 * SAMPLE_RATE);
      const mic = mix(n, { signal: echoOf(agent, { delayMs, gain }), at: Math.round(0.5 * SAMPLE_RATE) }, { signal: noise(rngFor(seed + 100), n, 0.003) });
      const guard = run({ agent, mic, upTo: Math.round(4.2 * SAMPLE_RATE) });
      const verdict = lastMs(guard, ECHO_GUARD.bargeWindowMs);
      assert.equal(verdict.echo, true, `delay ${delayMs} ms, gain ${gain}: ${JSON.stringify(verdict)}`);
    }
  });

  test("a reference at another sample rate (24 kHz voice) is followed the same way", () => {
    const agent16 = speechLike(7, 6);
    // the same loudness pattern at 24 kHz: repeat each sample 1.5 times
    const agent24 = new Float32Array(Math.round(agent16.length * 1.5));
    for (let i = 0; i < agent24.length; i++) agent24[i] = agent16[Math.min(agent16.length - 1, Math.floor(i / 1.5))];
    const n = Math.round(9 * SAMPLE_RATE);
    const mic = mix(n, { signal: echoOf(agent16, { delayMs: 250, gain: 0.1 }), at: Math.round(0.5 * SAMPLE_RATE) }, { signal: noise(rngFor(8), n, 0.003) });
    const guard = run({ agent: agent24, sampleRate: 24000, mic, upTo: Math.round(4 * SAMPLE_RATE) });
    assert.equal(lastMs(guard, ECHO_GUARD.bargeWindowMs).echo, true);
  });

  test("FAIL OPEN, headphones: a person talking while the agent plays, and no echo path, is never called an echo", () => {
    for (let seed = 10; seed < 20; seed++) {
      const agent = speechLike(seed, 6);
      const person = speechLike(seed + 500, 5, { level: 0.5 });
      const n = Math.round(9 * SAMPLE_RATE);
      const mic = mix(n, { signal: person, at: Math.round(0.8 * SAMPLE_RATE) }, { signal: noise(rngFor(seed), n, 0.003) });
      const guard = run({ agent, mic, upTo: Math.round(4.5 * SAMPLE_RATE) });
      for (const ms of [350, 600, 1500]) {
        const verdict = lastMs(guard, ms);
        assert.equal(verdict.echo, false, `seed ${seed}, last ${ms} ms: ${JSON.stringify(verdict)}`);
      }
      assert.equal(guard.path, null, "no echo path may be learned from an unrelated voice");
    }
  });

  test("REGRESSION: a shared onset is not an echo — an unrelated voice that starts after a quiet lead learns no path", () => {
    // Found by measurement: counting the quiet frames let "both go from quiet to loud at about the same time"
    // look like a 0.85 match, and an unrelated voice made the guard learn a path in 1 of 4 calls.
    let learned = 0;
    for (let seed = 0; seed < 40; seed++) {
      const agent = speechLike(1000 + seed, 12);
      const person = speechLike(9000 + seed, 12, { level: 0.5 });
      const rand = rngFor(seed);
      const guard = new EchoGuard();
      guard.pushReference(agent, SAMPLE_RATE, 500);
      for (let at = 0; at + 320 <= Math.round(10 * SAMPLE_RATE); at += 320) {
        const chunk = new Float32Array(320);
        for (let i = 0; i < 320; i++) chunk[i] = (at + i >= 12800 ? person[at + i - 12800] : 0) + (rand() * 2 - 1) * 0.003;
        guard.pushCaller(chunk, ((at + 320) / SAMPLE_RATE) * 1000);
        if (at % 1600 === 0) probe(guard);
      }
      if (guard.path) learned++;
    }
    assert.equal(learned, 0);
  });

  test("a real echo's path is adopted only once two separate attempts agree on the delay", () => {
    const agent = speechLike(110, 8);
    const n = Math.round(10 * SAMPLE_RATE);
    const mic = mix(n, { signal: echoOf(agent, { delayMs: 300, gain: 0.12 }), at: Math.round(0.5 * SAMPLE_RATE) }, { signal: noise(rngFor(111), n, 0.003) });
    const guard = new EchoGuard();
    guard.pushReference(agent, SAMPLE_RATE, 500);
    let firstCandidate = null;
    let adoptedAt = null;
    for (let at = 0; at + 320 <= Math.round(6 * SAMPLE_RATE); at += 320) {
      guard.pushCaller(mic.subarray(at, at + 320), ((at + 320) / SAMPLE_RATE) * 1000);
      if (at % 320 === 0) probe(guard);
      if (firstCandidate == null && guard.candidate) firstCandidate = at;
      if (adoptedAt == null && guard.path) adoptedAt = at;
    }
    assert.ok(firstCandidate != null && adoptedAt != null);
    assert.ok(adoptedAt > firstCandidate, "adopted after the first sighting, not on it");
    assert.ok(Math.abs(guard.path.lag * ECHO_GUARD.frameMs - 300) <= 40);
  });

  test("a person talking OVER the echo is let through the moment their voice is in the window", () => {
    const agent = speechLike(30, 8);
    const person = speechLike(31, 4, { level: 1.4 });
    const n = Math.round(10 * SAMPLE_RATE);
    const echo = echoOf(agent, { delayMs: 300, gain: 0.1 });
    const mic = mix(n, { signal: echo, at: Math.round(0.5 * SAMPLE_RATE) }, { signal: person, at: Math.round(4.2 * SAMPLE_RATE) }, { signal: noise(rngFor(32), n, 0.003) });
    // before the person: echo
    const before = run({ agent, mic, upTo: Math.round(4.0 * SAMPLE_RATE) });
    assert.equal(lastMs(before, ECHO_GUARD.bargeWindowMs).echo, true);
    // 0.8 s after the person began: not an echo
    const during = run({ agent, mic, upTo: Math.round(5.0 * SAMPLE_RATE) });
    const verdict = lastMs(during, ECHO_GUARD.bargeWindowMs);
    assert.equal(verdict.echo, false, JSON.stringify(verdict));
  });

  test("an utterance that is all echo is recognised over its whole span; one with a person in it is not", () => {
    const agent = speechLike(40, 8);
    const n = Math.round(11 * SAMPLE_RATE);
    const echo = echoOf(agent, { delayMs: 200, gain: 0.1 });
    const echoOnly = mix(n, { signal: echo, at: Math.round(0.5 * SAMPLE_RATE) }, { signal: noise(rngFor(41), n, 0.003) });
    const guard = run({ agent, mic: echoOnly, upTo: Math.round(9 * SAMPLE_RATE) });
    assert.equal(guard.assess(Math.round(1 * SAMPLE_RATE), Math.round(8.5 * SAMPLE_RATE)).echo, true);

    const person = speechLike(42, 3, { level: 1.2 });
    const withPerson = mix(n, { signal: echo, at: Math.round(0.5 * SAMPLE_RATE) }, { signal: person, at: Math.round(5 * SAMPLE_RATE) }, { signal: noise(rngFor(43), n, 0.003) });
    const guard2 = run({ agent, mic: withPerson, upTo: Math.round(9 * SAMPLE_RATE) });
    const verdict = guard2.assess(Math.round(1 * SAMPLE_RATE), Math.round(8.5 * SAMPLE_RATE));
    assert.equal(verdict.echo, false, JSON.stringify(verdict));
  });

  test("once the agent was cut off (barge-in) nothing after the cut is explained by it", () => {
    const agent = speechLike(50, 8);
    const n = Math.round(11 * SAMPLE_RATE);
    const person = speechLike(51, 4, { level: 1 });
    const echo = echoOf(agent, { delayMs: 300, gain: 0.1 });
    const mic = mix(n, { signal: echo, at: Math.round(0.5 * SAMPLE_RATE) }, { signal: person, at: Math.round(4.5 * SAMPLE_RATE) }, { signal: noise(rngFor(52), n, 0.003) });
    const guard = new EchoGuard();
    guard.pushReference(agent, SAMPLE_RATE, 500);
    for (let at = 0; at + 320 <= Math.round(6.5 * SAMPLE_RATE); at += 320) {
      guard.pushCaller(mic.subarray(at, at + 320), ((at + 320) / SAMPLE_RATE) * 1000);
      if (at % 3200 === 0) probe(guard);
      if (at === Math.round(5.2 * SAMPLE_RATE) - (Math.round(5.2 * SAMPLE_RATE) % 320)) guard.cutReference(5200);
    }
    const verdict = lastMs(guard, ECHO_GUARD.bargeWindowMs);
    assert.equal(verdict.echo, false, JSON.stringify(verdict));
  });

  test("a quiet microphone while the agent plays is 'nobody is talking' once an echo path is known", () => {
    const agent = speechLike(60, 6);
    const n = Math.round(9 * SAMPLE_RATE);
    const mic = mix(n, { signal: echoOf(agent, { delayMs: 200, gain: 0.1 }), at: Math.round(0.5 * SAMPLE_RATE) }, { signal: noise(rngFor(61), n, 0.002) });
    // the echo stops being heard (the agent's audio ended), only room noise remains
    const guard = new EchoGuard();
    guard.pushReference(agent, SAMPLE_RATE, 500);
    const cutoff = Math.round(5 * SAMPLE_RATE);
    for (let at = 0; at + 320 <= Math.round(8 * SAMPLE_RATE); at += 320) {
      const chunk = at < cutoff ? mic.subarray(at, at + 320) : noise(rngFor(at), 320, 0.002);
      guard.pushCaller(chunk, ((at + 320) / SAMPLE_RATE) * 1000);
      if (at % 3200 === 0) probe(guard);
    }
    assert.ok(guard.path, "the path was learned while the echo was audible");
    const verdict = lastMs(guard, ECHO_GUARD.bargeWindowMs);
    assert.equal(verdict.echo, true);
    assert.ok(["quiet", "echo_tail"].includes(verdict.reason), verdict.reason);
  });

  test("the path is forgotten when it has not been confirmed for 20 s", () => {
    const agent = speechLike(70, 5);
    const n = Math.round(40 * SAMPLE_RATE);
    const mic = mix(n, { signal: echoOf(agent, { delayMs: 300, gain: 0.1 }), at: Math.round(0.5 * SAMPLE_RATE) });
    const guard = run({ agent, mic, upTo: Math.round(4 * SAMPLE_RATE) });
    assert.ok(guard.path);
    // 25 s of a different, unrelated microphone signal with the agent silent
    const talk = speechLike(71, 25, { level: 0.5 });
    for (let at = 0; at + 320 <= talk.length; at += 320) {
      guard.pushCaller(talk.subarray(at, at + 320), ((Math.round(4 * SAMPLE_RATE) + at + 320) / SAMPLE_RATE) * 1000);
      if (at % 32000 === 0) probe(guard);
    }
    const verdict = lastMs(guard, ECHO_GUARD.bargeWindowMs);
    assert.equal(verdict.echo, false);
    assert.equal(guard.path, null);
  });

  test("with nothing played, or too little heard, it answers 'not an echo'", () => {
    const fresh = new EchoGuard();
    assert.deepEqual(fresh.assess(0, 9600), { echo: false, reason: "no_reference" });
    const guard = run({ agent: null, mic: noise(rngFor(80), SAMPLE_RATE, 0.05) });
    assert.equal(guard.assess(0, guard.position).echo, false);
  });

  test("a short window is never decided (fewer than minWindowFrames)", () => {
    const agent = speechLike(90, 6);
    const n = Math.round(9 * SAMPLE_RATE);
    const mic = mix(n, { signal: echoOf(agent, { delayMs: 300, gain: 0.1 }), at: Math.round(0.5 * SAMPLE_RATE) });
    const guard = run({ agent, mic, upTo: Math.round(4 * SAMPLE_RATE) });
    const verdict = guard.assess(guard.position - 1600, guard.position); // 100 ms
    assert.equal(verdict.echo, false);
    assert.equal(verdict.reason, "short_window");
  });

  test("a steady loud signal (a fan, a held tone) is not decided as an echo", () => {
    const agent = speechLike(100, 6);
    const n = Math.round(9 * SAMPLE_RATE);
    // learn a path first, then a steady noise at −30 dBFS
    const echo = mix(n, { signal: echoOf(agent, { delayMs: 300, gain: 0.1 }), at: Math.round(0.5 * SAMPLE_RATE) });
    const guard = new EchoGuard();
    guard.pushReference(agent, SAMPLE_RATE, 500);
    for (let at = 0; at + 320 <= Math.round(8 * SAMPLE_RATE); at += 320) {
      const chunk = at < Math.round(4 * SAMPLE_RATE) ? echo.subarray(at, at + 320) : noise(rngFor(at + 7), 320, 0.05);
      guard.pushCaller(chunk, ((at + 320) / SAMPLE_RATE) * 1000);
      if (at % 3200 === 0) probe(guard);
    }
    const verdict = lastMs(guard, ECHO_GUARD.bargeWindowMs);
    assert.equal(verdict.echo, false, JSON.stringify(verdict));
  });

  test("COLD START: before the guard has heard enough of the agent to look for an echo path, a sound waits (coldGraceMs), then interrupts", () => {
    const agent = speechLike(120, 6);
    const n = Math.round(8 * SAMPLE_RATE);
    const person = speechLike(121, 3, { level: 0.6 });
    const mic = mix(n, { signal: person, at: Math.round(0.6 * SAMPLE_RATE) }, { signal: noise(rngFor(122), n, 0.003) });
    const guard = new EchoGuard();
    guard.pushReference(agent, SAMPLE_RATE, 500);
    // 0.6 s into the agent's speech: far too little to have judged anything
    for (let at = 0; at + 320 <= Math.round(1.1 * SAMPLE_RATE); at += 320) guard.pushCaller(mic.subarray(at, at + 320), ((at + 320) / SAMPLE_RATE) * 1000);
    assert.equal(guard.evaluated, false);
    const ask = (nowMs) => guard.bargeCheck(guard.position - 9600, guard.position, nowMs);
    guard.speechStarted();
    assert.equal(ask(1100).own, true, "held: not known yet");
    assert.equal(ask(1100 + ECHO_GUARD.coldGraceMs - 50).own, true);
    assert.equal(ask(1100 + ECHO_GUARD.coldGraceMs + 10).own, false, "the grace is over: interrupt as before");
  });

  test("HEADPHONES after the cold start: once the guard HAS judged and found no echo, a sound interrupts at once", () => {
    const agent = speechLike(130, 8);
    const person = speechLike(131, 6, { level: 0.5 });
    const n = Math.round(8 * SAMPLE_RATE);
    const mic = mix(n, { signal: person, at: Math.round(0.8 * SAMPLE_RATE) }, { signal: noise(rngFor(132), n, 0.003) });
    const guard = new EchoGuard();
    guard.pushReference(agent, SAMPLE_RATE, 500);
    for (let at = 0; at + 320 <= Math.round(4.5 * SAMPLE_RATE); at += 320) {
      guard.pushCaller(mic.subarray(at, at + 320), ((at + 320) / SAMPLE_RATE) * 1000);
      if (at % 3200 === 0) probe(guard);
    }
    assert.equal(guard.evaluated, true);
    assert.equal(guard.path, null);
    guard.speechStarted();
    const verdict = guard.bargeCheck(guard.position - 9600, guard.position, 4500);
    assert.equal(verdict.own, false);
    assert.equal(verdict.verdict.reason, "no_echo_path");
  });

  test("BETWEEN SENTENCES: with a known path and nothing to compare with yet, a sound waits undecidedGraceMs, then interrupts", () => {
    const agent = speechLike(140, 5);
    const n = Math.round(14 * SAMPLE_RATE);
    // a path is learned from the first 5 s; then the agent is silent for the rest of the call
    const mic = mix(n, { signal: echoOf(agent, { delayMs: 300, gain: 0.12 }), at: Math.round(0.5 * SAMPLE_RATE) }, { signal: noise(rngFor(141), n, 0.003) });
    const person = speechLike(142, 5, { level: 0.6 });
    const guard = new EchoGuard();
    guard.pushReference(agent, SAMPLE_RATE, 500);
    for (let at = 0; at + 320 <= Math.round(10 * SAMPLE_RATE); at += 320) {
      const chunk = mic.slice(at, at + 320);
      if (at >= Math.round(8 * SAMPLE_RATE)) for (let i = 0; i < 320; i++) chunk[i] += person[at - Math.round(8 * SAMPLE_RATE) + i] ?? 0;
      guard.pushCaller(chunk, ((at + 320) / SAMPLE_RATE) * 1000);
      if (at % 3200 === 0 && at < Math.round(6 * SAMPLE_RATE)) probe(guard);
    }
    assert.ok(guard.path, "learned during the first sentence");
    guard.speechStarted();
    const first = guard.bargeCheck(guard.position - 9600, guard.position, 10_000);
    assert.equal(first.verdict.undecided, true, JSON.stringify(first.verdict));
    assert.equal(first.own, true, "waits");
    assert.equal(guard.bargeCheck(guard.position - 9600, guard.position, 10_000 + ECHO_GUARD.undecidedGraceMs - 20).own, true);
    assert.equal(guard.bargeCheck(guard.position - 9600, guard.position, 10_000 + ECHO_GUARD.undecidedGraceMs + 20).own, false, "then interrupts");
    // a new stretch of speech starts the wait over
    guard.speechStarted();
    assert.equal(guard.bargeCheck(guard.position - 9600, guard.position, 20_000).own, true);
  });

  test("A WHOLE UTTERANCE is judged window by window: a long stretch of echo cannot carry a person's words with it", () => {
    const agent = speechLike(150, 14);
    const n = Math.round(18 * SAMPLE_RATE);
    const echo = echoOf(agent, { delayMs: 300, gain: 0.1 });
    // a person about as loud as the echo: judged as ONE window the 13 s of echo around them outvotes them
    // (measured: that is exactly the level at which one window says "echo" and window-by-window says "not")
    const person = speechLike(151, 3, { level: 0.25 });
    const base = [{ signal: echo, at: Math.round(0.5 * SAMPLE_RATE) }, { signal: noise(rngFor(152), n, 0.003) }];
    const echoOnly = run({ agent, mic: mix(n, ...base), upTo: Math.round(15 * SAMPLE_RATE) });
    const from = Math.round(1 * SAMPLE_RATE);
    const to = Math.round(14.5 * SAMPLE_RATE);
    assert.equal(echoOnly.assessSpan(from, to).echo, true, "13 s of pure echo is dropped");

    const withPerson = run({ agent, mic: mix(n, ...base, { signal: person, at: Math.round(11.5 * SAMPLE_RATE) }), upTo: Math.round(15 * SAMPLE_RATE) });
    const verdict = withPerson.assessSpan(from, to);
    assert.equal(verdict.echo, false, "the same stretch with three seconds of a person at its end is kept");
  });

  test("the switch: on unless VOICE_ECHO_GUARD is 0, false, off or no", () => {
    assert.equal(echoGuardEnabled({}), true);
    assert.equal(echoGuardEnabled({ VOICE_ECHO_GUARD: "" }), true);
    assert.equal(echoGuardEnabled({ VOICE_ECHO_GUARD: "1" }), true);
    for (const v of ["0", "false", "OFF", "no", " off "]) assert.equal(echoGuardEnabled({ VOICE_ECHO_GUARD: v }), false, v);
  });
});
