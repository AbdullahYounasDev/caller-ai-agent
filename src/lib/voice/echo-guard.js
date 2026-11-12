import { ECHO_GUARD, SAMPLE_RATE } from "./config";

/**
 * THE ECHO GUARD — "is what the microphone hears just the agent's own voice coming back?"
 *
 * Without headphones the agent's voice leaves the speaker and re-enters the microphone. The browser's echo
 * cancellation removes most of it, a phone line's far end (a speakerphone) often none. The voice detector
 * hears the rest as a person talking, so the agent "was interrupted" by itself 4–13 times a call (§6.24), and
 * the tail of its own last words came back as a question nobody asked.
 *
 * The gateway knows exactly what it played and when, so it can ask the right question without any model:
 * does the loudness pattern of the microphone follow the loudness pattern of the agent's audio some
 * milliseconds earlier? A reply's syllables rise and fall in a pattern no other voice repeats, so a person
 * talking over the agent does not match, however loud, and an echo matches through any room, level or delay.
 * This is NOT an echo canceller: it removes nothing, it only refuses to mistake the agent for the caller.
 *
 * ── How it decides, in two steps (the first version used one step and was measured too weak) ───────────
 *  1. LEARN THE ECHO PATH. Over a LONG stretch of the agent's speech (≥ 0.6 s, up to 2.5 s) search every delay
 *     for the one at which the microphone follows the agent. A long stretch with a high match (≥ 0.85) cannot
 *     happen by chance across ~100 delays; a short one can (random non-echo audio reached 0.78–0.80 over
 *     600 ms). No such delay → there IS no echo path (headphones, a quiet room) and the guard says "not an
 *     echo" to everything. Re-learned as the call goes on; forgotten after 20 s without confirmation.
 *  2. ASK AT THAT DELAY ONLY. At a barge-in (the last 600 ms) or for a whole utterance: with the delay known
 *     there is nothing to search, so a modest match (≥ 0.55) is already strong evidence — and the microphone
 *     must not hold more than the echo explains (a person talking over the agent adds energy the agent's
 *     audio does not predict).
 *
 * ── Design rules that must not drift ─────────────────────────────────────────────────────────────────
 *  - FAIL OPEN. Every doubt answers "not an echo": no path learned yet (the first second of a call's first
 *    sentence), no reference audio at that moment, a flat signal, a short window, a weak match, a microphone
 *    louder than the echo can explain. A wrongly kept barge-in is today's behaviour; a wrongly suppressed one
 *    makes the agent deaf to a person trying to stop it.
 *  - Headphones cost nothing: no echo path → every question is answered "not an echo".
 *  - Pure and clock-free: all times are passed in, so tests/voice-echo-guard.test.mjs drives it with synthetic
 *    signals and the same code runs in the gateway.
 *  - Two timelines, joined by a measured offset: the caller's by sample count (continuous), the agent's by the
 *    gateway's clock (when the audio is expected to be heard). Their offset is the smallest "arrival time
 *    minus samples received" seen, which jitter can only make larger; the delay search absorbs the rest.
 */

const FRAME_MS = ECHO_GUARD.frameMs;
const CALLER_FRAME = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
const RING = 6000; // 60 s of 10 ms frames: longer than any utterance (VAD.maxSpeechSeconds)

/** log-envelope: 0 at the floor, rising ~1 per e-fold; makes the match independent of level. */
function logEnv(rms) {
  return Math.log(Math.max(rms, ECHO_GUARD.floor) / ECHO_GUARD.floor);
}

export class EchoGuard {
  constructor() {
    /** rms per caller frame, by caller sample position. */
    this.caller = new Float32Array(RING);
    this.callerFrames = 0; // complete frames so far
    this.pendingSum = 0;
    this.pendingCount = 0;
    this.totalSamples = 0;
    /** wall time (ms) of caller sample 0, as far as can be told. */
    this.wallAtZero = null;
    /** rms per wall frame of the audio the agent sent, as it is expected to be heard. */
    this.ref = new Float32Array(RING);
    this.refMax = null; // highest wall frame written
    /** The learned echo path: { lag (frames), correlation, atFrame (caller frame it was last confirmed) } or null. */
    this.path = null;
    /** What the last learning attempt found, not yet confirmed by a second one. */
    this.candidate = null;
    this.lastLearnFrame = -Infinity;
    this.undecidedSince = null;
    /** Has a learning attempt ever had enough of the agent's audio to judge (echo path or not)? */
    this.evaluated = false;
  }

  // ── the agent's side ─────────────────────────────────────────────────────

  /**
   * The agent's audio, which will be heard from `playsAtMs` (the gateway's clock).
   * @param {Float32Array} samples
   * @param {number} sampleRate
   * @param {number} playsAtMs
   */
  pushReference(samples, sampleRate, playsAtMs) {
    const frameLen = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
    const first = Math.round(playsAtMs / FRAME_MS);
    const count = Math.floor(samples.length / frameLen);
    // Frames between the last thing written and this piece are silence: never stale data from a previous lap.
    if (this.refMax != null && first > this.refMax + 1) this.zero(this.refMax + 1, first - 1);
    else if (this.refMax == null) this.refMax = first - 1;
    for (let j = 0; j < count; j++) {
      let sum = 0;
      for (let i = j * frameLen, end = i + frameLen; i < end; i++) sum += samples[i] * samples[i];
      this.ref[mod(first + j)] = Math.sqrt(sum / frameLen);
    }
    this.refMax = Math.max(this.refMax, first + count - 1);
  }

  /** The agent stopped (barge-in): nothing sent after this moment will be heard. */
  cutReference(atMs) {
    if (this.refMax == null) return;
    const from = Math.round(atMs / FRAME_MS);
    if (from <= this.refMax) this.zero(from, this.refMax);
    this.refMax = Math.min(this.refMax, from - 1);
  }

  zero(from, to) {
    const start = Math.max(from, to - RING + 1);
    for (let f = start; f <= to; f++) this.ref[mod(f)] = 0;
  }

  // ── the caller's side ────────────────────────────────────────────────────

  /**
   * Microphone audio, 16 kHz, just received at `arrivalMs`.
   * @param {Float32Array} samples
   * @param {number} arrivalMs
   */
  pushCaller(samples, arrivalMs) {
    this.totalSamples += samples.length;
    const zeroAt = arrivalMs - (this.totalSamples / SAMPLE_RATE) * 1000;
    this.wallAtZero = this.wallAtZero == null ? zeroAt : Math.min(this.wallAtZero, zeroAt);
    for (let i = 0; i < samples.length; i++) {
      this.pendingSum += samples[i] * samples[i];
      if (++this.pendingCount === CALLER_FRAME) {
        this.caller[this.callerFrames % RING] = Math.sqrt(this.pendingSum / CALLER_FRAME);
        this.callerFrames++;
        this.pendingSum = 0;
        this.pendingCount = 0;
      }
    }
    // Learn the echo path as the call goes on, not only when somebody asks: the first question (a sound that
    // might be an interruption) comes within a second of the agent starting to speak, and a path learned
    // only then would arrive too late to answer it. Only while the agent has been audible lately.
    if (this.refMax != null && Math.round(arrivalMs / FRAME_MS) - this.refMax <= ECHO_GUARD.learnWhileRecentFrames) {
      this.learnPath(this.callerFrames);
    }
  }

  /** Where the caller's stream is now, in samples: "the last 600 ms" is (position − 9600, position). */
  get position() {
    return this.totalSamples;
  }

  // ── the question ─────────────────────────────────────────────────────────

  /**
   * Over the caller's samples [fromSample, toSample): is the microphone explained by the agent's own audio?
   * @returns {{echo: boolean, reason: string, correlation?: number, lagMs?: number, gain?: number, residual?: number}}
   */
  assess(fromSample, toSample) {
    if (this.wallAtZero == null || this.refMax == null) return { echo: false, reason: "no_reference" };
    const endFrame = Math.min(Math.floor(toSample / CALLER_FRAME), this.callerFrames);
    this.learnPath(endFrame);
    // No echo path. If the guard has not yet had enough of the agent's audio to look for one (the first second or
    // so of the call's first words), that is "not yet known", not "there is none": see bargeCheck().
    if (!this.path) return { echo: false, reason: "no_echo_path", ...(this.evaluated && !this.candidate ? {} : { undecided: true, cold: true }) };

    const w = this.window(fromSample, toSample);
    if (!w) return { echo: false, reason: "short_window" };
    if (w.cVar / w.n < ECHO_GUARD.minVariance) {
      // Nothing moves on the microphone. If it is also quiet, nobody is talking: the detector is still "detected"
      // only because it waits out its silence window after the last sound, and interrupting the agent for that
      // helps no one. A steady LOUD signal (a held tone, a fan) is not decided here.
      return w.meanRms < ECHO_GUARD.quietRms ? { echo: true, reason: "quiet" } : { echo: false, reason: "flat_microphone" };
    }

    // Only the learned delay, give or take a few frames (the path moves a little as the call goes on).
    let best = null;
    for (let lag = this.path.lag - ECHO_GUARD.lagToleranceFrames; lag <= this.path.lag + ECHO_GUARD.lagToleranceFrames; lag++) {
      const m = this.match(w, lag);
      if (m && (!best || m.rho > best.rho)) best = m;
    }
    // The echo path is known but the agent was (almost) silent at that delay within this window: a gap between two
    // sentences, or the very start of the next one. Not a verdict either way — see bargeCheck().
    if (!best) return this.tailExplains(w) ? { echo: true, reason: "echo_tail" } : { echo: false, reason: "no_reference", undecided: true };
    const lagMs = best.lag * FRAME_MS;
    if (best.rho < ECHO_GUARD.minCorrelation) return { echo: false, reason: "no_match", correlation: round(best.rho), lagMs };

    // The size of the echo, and whether the microphone holds more than that explains.
    let num = 0;
    let den = 0;
    for (let i = 0; i < w.n; i++) {
      num += w.c[i] * best.r[i];
      den += best.r[i] * best.r[i];
    }
    const gain = den > 0 ? num / den : 0;
    if (!(gain > 0) || gain > ECHO_GUARD.maxGain) return { echo: false, reason: "implausible_gain", correlation: round(best.rho), lagMs, gain: round(gain) };
    // The loss between speaker and microphone does not change from one sentence to the next. An "echo" many times
    // larger than the one learned is a louder sound that happens to share some of the agent's rhythm — a person.
    if (this.path.gain > 0 && gain > this.path.gain * ECHO_GUARD.gainDrift) {
      return { echo: false, reason: "louder_than_learned_echo", correlation: round(best.rho), lagMs, gain: round(gain) };
    }
    let excess = 0;
    let total = 0;
    for (let i = 0; i < w.n; i++) {
      excess += Math.max(0, w.c[i] - ECHO_GUARD.residualMargin * gain * best.r[i] - ECHO_GUARD.floor);
      total += w.c[i];
    }
    const residual = total > 0 ? excess / total : 1;
    const out = { correlation: round(best.rho), lagMs, gain: round(gain), residual: round(residual) };
    if (residual > ECHO_GUARD.maxResidual) return { echo: false, reason: "louder_than_echo", ...out };
    return { echo: true, reason: "echo", ...out };
  }

  /**
   * The agent has just stopped (the end of a sentence, a pause inside the reply) but its echo is still coming
   * back — the room's reverberation and the delay. There is no agent audio to follow in the window, so the
   * correlation cannot be asked. It is an echo TAIL only if all of this holds, else it is not decided here:
   *   - the agent was audible at the learned delay shortly before (≥ 5 frames in the preceding 0.8 s);
   *   - the microphone is not rising (a person starting to speak rises out of the tail);
   *   - and never louder than the strongest recent echo the learned loss explains.
   */
  tailExplains(w) {
    if (!this.path || !(this.path.gain > 0)) return false;
    const base = Math.round(this.wallAtZero / FRAME_MS);
    const lag = this.path.lag;
    const lookBack = Math.round(ECHO_GUARD.tailLookBackMs / FRAME_MS);
    let active = 0;
    let peak = 0;
    for (let i = -lookBack; i < w.n; i++) {
      const v = this.refAt(base + w.f0 + i - lag);
      if (v > ECHO_GUARD.floor * 2) active++;
      if (v > peak) peak = v;
    }
    if (active < ECHO_GUARD.tailMinFrames) return false;
    const edge = Math.min(20, w.n >> 1);
    let first = 0;
    let last = 0;
    let top = 0;
    for (let i = 0; i < edge; i++) {
      first += w.c[i];
      last += w.c[w.n - 1 - i];
    }
    for (let i = 0; i < w.n; i++) top = Math.max(top, w.c[i]);
    if (last / edge > ECHO_GUARD.tailRisingRatio * (first / edge) + ECHO_GUARD.floor) return false;
    return top <= ECHO_GUARD.residualMargin * this.path.gain * peak + ECHO_GUARD.floor;
  }

  /**
   * THE QUESTION AT A BARGE-IN: should the sound the detector has been hearing for BARGE_IN.minSpeechMs be treated
   * as the agent's own voice right now? `assess` over the latest window, plus one allowance: while the answer is
   * "undecided" (the agent is between two sentences, or just starting one, so there is nothing to compare with
   * yet) the sound is given ECHO_GUARD.undecidedGraceMs to become decidable — a few more frames of the next
   * sentence settle it — before the agent is interrupted anyway. Every decisive "not an echo" interrupts at once.
   *
   * @param {number} fromSample
   * @param {number} toSample
   * @param {number} nowMs  the gateway's clock
   * @returns {{own: boolean, verdict: object}}
   */
  bargeCheck(fromSample, toSample, nowMs) {
    const verdict = this.assess(fromSample, toSample);
    if (verdict.echo) {
      this.undecidedSince = null;
      return { own: true, verdict };
    }
    if (verdict.undecided) {
      this.undecidedSince ??= nowMs;
      // Cold start (nothing learned yet, too little of the agent's audio to learn from) waits longer than a gap between sentences.
      const grace = verdict.cold ? ECHO_GUARD.coldGraceMs : ECHO_GUARD.undecidedGraceMs;
      if (nowMs - this.undecidedSince < grace) return { own: true, verdict: { ...verdict, reason: "undecided" } };
      return { own: false, verdict };
    }
    this.undecidedSince = null;
    return { own: false, verdict };
  }

  /**
   * THE QUESTION ABOUT A WHOLE UTTERANCE: is every part of it the agent's own voice? Judged in windows of
   * ECHO_GUARD.spanWindowFrames, each of which must be an echo, because one stretch of echo must not be able to
   * carry a person's words with it (measured: a 14 s detector segment of echo with a person speaking at its end
   * was judged "echo" as a whole, and the person was not answered). A window with no verdict, or no match, keeps
   * the utterance. A span shorter than a window is judged as one.
   *
   * @returns {{echo: boolean, windows: number, reason?: string}}
   */
  assessSpan(fromSample, toSample) {
    const size = ECHO_GUARD.spanWindowFrames * CALLER_FRAME;
    const hop = Math.round(size / 2);
    const starts = [];
    for (let s = fromSample; s + size < toSample; s += hop) starts.push(s);
    starts.push(Math.max(fromSample, toSample - size)); // the last window always ends at the end of the utterance
    let last = null;
    for (const s of starts) {
      last = this.assess(s, Math.min(toSample, s + size));
      if (!last.echo) return { echo: false, windows: starts.length, reason: last.reason, ...(last.correlation != null ? { correlation: last.correlation } : {}) };
    }
    return { echo: true, windows: starts.length, reason: last?.reason ?? "echo", correlation: last?.correlation, lagMs: last?.lagMs };
  }

  /** A new stretch of speech began: the grace starts over. */
  speechStarted() {
    this.undecidedSince = null;
  }

  /** Step 1: look for the echo path over a long stretch of the agent's speech ending at `endFrame`. */
  learnPath(endFrame) {
    if (this.path && endFrame - this.path.atFrame > ECHO_GUARD.forgetAfterFrames) this.path = null;
    if (endFrame - this.lastLearnFrame < ECHO_GUARD.relearnEveryFrames) return;
    this.lastLearnFrame = endFrame;
    const n = Math.min(ECHO_GUARD.learnWindowFrames, endFrame);
    if (n < ECHO_GUARD.minLearnFrames) return;
    const w = this.window((endFrame - n) * CALLER_FRAME, endFrame * CALLER_FRAME);
    if (!w || w.cVar / w.n < ECHO_GUARD.minVariance) return;
    let best = null;
    const minLag = Math.round(ECHO_GUARD.minLagMs / FRAME_MS);
    const maxLag = Math.round(ECHO_GUARD.maxLagMs / FRAME_MS);
    // Searching ~100 delays, a short overlap finds a "match" by chance: learning needs a long stretch of speech.
    for (let lag = minLag; lag <= maxLag; lag++) {
      const m = this.match(w, lag, ECHO_GUARD.learnMinActiveFrames);
      if (m) this.evaluated = true; // at least one delay had enough of the agent's audio to be judged
      if (m && (!best || m.rho > best.rho)) best = m;
    }
    if (best && best.rho >= ECHO_GUARD.learnCorrelation) {
      let num = 0;
      let den = 0;
      for (let i = 0; i < w.n; i++) {
        num += w.c[i] * best.r[i];
        den += best.r[i] * best.r[i];
      }
      const found = { lag: best.lag, correlation: best.rho, gain: den > 0 ? num / den : 0, atFrame: endFrame };
      // A real echo path holds still; a chance match wanders. Adopt a delay only when the attempt before this one
      // (a different window, ≥ relearnEveryFrames earlier) found the same one — or when it is the path already held.
      const agrees = (a) => a && Math.abs(a.lag - found.lag) <= ECHO_GUARD.lagToleranceFrames;
      if (agrees(this.path) || agrees(this.candidate)) this.path = found;
      this.candidate = found;
    } else {
      this.candidate = null;
    }
  }

  /** The caller's envelope over [fromSample, toSample), or null when too short. */
  window(fromSample, toSample) {
    const oldest = Math.max(0, this.callerFrames - RING + 1);
    const f0 = Math.max(Math.ceil(fromSample / CALLER_FRAME), oldest);
    const f1 = Math.min(Math.floor(toSample / CALLER_FRAME), this.callerFrames);
    const n = f1 - f0;
    if (n < ECHO_GUARD.minWindowFrames) return null;
    const c = new Float32Array(n);
    const lc = new Float32Array(n);
    let cMean = 0;
    let meanRms = 0;
    for (let i = 0; i < n; i++) {
      c[i] = this.caller[(f0 + i) % RING];
      lc[i] = logEnv(c[i]);
      cMean += lc[i];
      meanRms += c[i];
    }
    cMean /= n;
    meanRms /= n;
    let cVar = 0;
    for (let i = 0; i < n; i++) cVar += (lc[i] - cMean) ** 2;
    return { f0, n, c, lc, cMean, cVar, meanRms };
  }

  /** How well the agent's audio `lag` frames earlier follows this window; null when the agent was not audible then. */
  match(w, lag, minActive = ECHO_GUARD.minReferenceFrames) {
    const base = Math.round(this.wallAtZero / FRAME_MS);
    const r = new Float32Array(w.n);
    const on = new Uint8Array(w.n);
    let active = 0;
    for (let i = 0; i < w.n; i++) {
      const v = this.refAt(base + w.f0 + i - lag);
      r[i] = v;
      if (v > ECHO_GUARD.floor * 2) {
        on[i] = 1;
        active++;
      }
    }
    // The agent must actually have been audible for a while within the window at this lag.
    if (active < minActive) return null;
    // Compare the patterns ONLY while the agent is audible. Counting the quiet frames lets a shared silence and a
    // shared onset (both signals go from quiet to loud at about the same time) look like a match: measured, an
    // unrelated voice that began a few hundred ms after a quiet lead gave a "match" of 0.85+ in 1 of 4 cases.
    // Inside the agent's speech, only an echo follows its syllables.
    let rMean = 0;
    let cMean = 0;
    for (let i = 0; i < w.n; i++) {
      if (!on[i]) continue;
      rMean += logEnv(r[i]);
      cMean += w.lc[i];
    }
    rMean /= active;
    cMean /= active;
    let rVar = 0;
    let cVar = 0;
    let cov = 0;
    for (let i = 0; i < w.n; i++) {
      if (!on[i]) continue;
      const a = logEnv(r[i]) - rMean;
      const b = w.lc[i] - cMean;
      rVar += a * a;
      cVar += b * b;
      cov += a * b;
    }
    if (rVar / active < ECHO_GUARD.minVariance || cVar / active < ECHO_GUARD.minVariance) return null;
    return { rho: cov / Math.sqrt(rVar * cVar), lag, r, active };
  }

  refAt(wallFrame) {
    if (this.refMax == null || wallFrame > this.refMax || wallFrame <= this.refMax - RING) return 0;
    return this.ref[mod(wallFrame)];
  }
}

function mod(f) {
  return ((f % RING) + RING) % RING;
}

function round(x) {
  return Math.round(x * 100) / 100;
}
