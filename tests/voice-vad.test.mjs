import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { SampleHistory, VoiceActivity } from "@/lib/voice/speech/vad";
import { VAD, VAD_WINDOW_SAMPLES, SAMPLE_RATE } from "@/lib/voice/config";

// The pre-roll (CLAUDE.md §6.30 / config.js VAD.prerollMs): the detector starts an utterance a little
// after the caller's first word; the audio before it is given back from what was received.

const PRE = Math.round((VAD.prerollMs / 1000) * SAMPLE_RATE);

/** A detector that reports whatever segments the test scripts, once enough audio has gone in. */
function fakeSherpa(segments) {
  return {
    Vad: class {
      constructor() {
        this.seen = 0;
        this.queue = [];
        this.script = [...segments];
      }
      acceptWaveform(window) {
        this.seen += window.length;
        while (this.script.length && this.script[0].emitAt <= this.seen) this.queue.push(this.script.shift());
      }
      isDetected() {
        return false;
      }
      isEmpty() {
        return this.queue.length === 0;
      }
      front() {
        const { start, length, fill = 1 } = this.queue[0];
        return { start, samples: new Float32Array(length).fill(fill) };
      }
      pop() {
        this.queue.shift();
      }
      reset() {
        this.seen = 0;
      }
    },
  };
}

/** Audio whose sample VALUE is its position / 1e6, so a test can see exactly which part came back. */
const ramp = (from, to) => Float32Array.from({ length: to - from }, (_, i) => (from + i) / 1e6);
const feed = (vad, total) => {
  const events = [];
  for (let at = 0; at + VAD_WINDOW_SAMPLES <= total; at += VAD_WINDOW_SAMPLES) events.push(...vad.push(ramp(at, at + VAD_WINDOW_SAMPLES)));
  return events;
};

describe("sample history", () => {
  test("returns exactly the asked span by absolute position; what has gone or not arrived is clipped", () => {
    const h = new SampleHistory(10);
    h.push(Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
    assert.deepEqual([...h.slice(2, 5)], [2, 3, 4]);
    h.push(Float32Array.from([8, 9, 10, 11, 12]));
    assert.deepEqual([...h.slice(0, 20)], [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "older than the ring is gone, newer than received is not invented");
    assert.deepEqual([...h.slice(12, 10)], []);
    h.clear();
    assert.deepEqual([...h.slice(0, 5)], []);
  });
});

describe("pre-roll", () => {
  test("an utterance gets the audio from just before the detector's start, and its duration stays the speech itself", () => {
    const start = 20 * VAD_WINDOW_SAMPLES; // well after the stream began
    const length = 40 * VAD_WINDOW_SAMPLES;
    const vad = new VoiceActivity({ sherpa: fakeSherpa([{ start, length, emitAt: start + length }]), config: {} });
    const [utterance] = feed(vad, start + length + VAD_WINDOW_SAMPLES).filter((e) => e.type === "utterance");
    assert.equal(utterance.samples.length, PRE + length);
    assert.equal(utterance.prerollMs, VAD.prerollMs);
    assert.equal(utterance.durationMs, Math.round((length / SAMPLE_RATE) * 1000));
    assert.equal(utterance.samples[0], Math.fround((start - PRE) / 1e6), "starts where the stream was PRE samples before the detector's start");
    assert.equal(utterance.samples[PRE], 1, "then the detector's own segment");
  });

  test("a call that begins mid-word has only as much pre-roll as exists (never negative, never invented)", () => {
    const start = 2 * VAD_WINDOW_SAMPLES; // the detector believed it 2 windows in
    const vad = new VoiceActivity({ sherpa: fakeSherpa([{ start, length: 1024, emitAt: 2048 }]), config: {} });
    const [utterance] = feed(vad, 5 * VAD_WINDOW_SAMPLES).filter((e) => e.type === "utterance");
    assert.equal(utterance.samples.length, start + 1024);
    assert.equal(utterance.samples[0], 0);
  });

  test("a second utterance's pre-roll never reaches back into the first (nothing heard twice)", () => {
    const first = { start: 20 * VAD_WINDOW_SAMPLES, length: 10 * VAD_WINDOW_SAMPLES, fill: 1 };
    const second = { start: first.start + first.length + 2 * VAD_WINDOW_SAMPLES, length: 10 * VAD_WINDOW_SAMPLES, fill: 2 };
    const vad = new VoiceActivity({
      sherpa: fakeSherpa([{ ...first, emitAt: first.start + first.length }, { ...second, emitAt: second.start + second.length }]),
      config: {},
    });
    const utterances = feed(vad, second.start + second.length + VAD_WINDOW_SAMPLES).filter((e) => e.type === "utterance");
    assert.equal(utterances.length, 2);
    assert.equal(utterances[1].samples.length, 2 * VAD_WINDOW_SAMPLES + second.length, "only the 2 windows of gap, not the full pre-roll");
    assert.equal(utterances[1].samples[0], Math.fround((first.start + first.length) / 1e6));
  });

  test("a detector that reports no position changes nothing", () => {
    const vad = new VoiceActivity({ sherpa: fakeSherpa([{ start: undefined, length: 512, emitAt: 1024 }]), config: {} });
    const [utterance] = feed(vad, 3 * VAD_WINDOW_SAMPLES).filter((e) => e.type === "utterance");
    assert.equal(utterance.samples.length, 512);
    assert.equal(utterance.prerollMs, 0);
  });

  test("reset forgets the history: the next call's utterance cannot borrow the last one's audio", () => {
    const vad = new VoiceActivity({ sherpa: fakeSherpa([{ start: 10 * VAD_WINDOW_SAMPLES, length: 512, emitAt: 12 * VAD_WINDOW_SAMPLES }]), config: {} });
    feed(vad, 5 * VAD_WINDOW_SAMPLES);
    vad.reset();
    assert.equal(vad.history.total, 0);
    assert.equal(vad.lastEnd, 0);
  });
});
