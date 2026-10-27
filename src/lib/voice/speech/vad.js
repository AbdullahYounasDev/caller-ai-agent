import { VAD, VAD_WINDOW_SAMPLES, SAMPLE_RATE } from "../config";

const PREROLL_SAMPLES = Math.round((VAD.prerollMs / 1000) * SAMPLE_RATE);

/**
 * THE LAST FEW SECONDS OF AUDIO, by absolute position. The detector reports an utterance only after
 * it decided speech had begun, which is a little after it really began (and, when the stream starts
 * mid-word, not before the stream itself); this lets the start of the utterance be taken back from
 * what was actually received. A fixed-size ring: memory per call is constant.
 */
export class SampleHistory {
  /** @param {number} capacity  samples kept */
  constructor(capacity) {
    this.ring = new Float32Array(capacity);
    this.total = 0;
  }

  push(samples) {
    const n = this.ring.length;
    for (let i = 0; i < samples.length; i++) this.ring[(this.total + i) % n] = samples[i];
    this.total += samples.length;
  }

  /** Samples [from, to) by absolute position; positions that are gone or not yet received are clipped. */
  slice(from, to) {
    const start = Math.max(from, this.total - this.ring.length, 0);
    const end = Math.min(to, this.total);
    if (end <= start) return new Float32Array(0);
    const out = new Float32Array(end - start);
    for (let i = start; i < end; i++) out[i - start] = this.ring[i % this.ring.length];
    return out;
  }

  clear() {
    this.total = 0;
  }
}

/**
 * VOICE ACTIVITY DETECTION for ONE call — turns a continuous stream of microphone audio
 * into "the caller started talking", "the caller is still talking (for N ms)" and
 * "here is one complete utterance".
 *
 * One instance per call: Silero keeps state across windows, and two callers must never
 * share it. Creating one costs a few milliseconds (the model is 0.6 MB).
 *
 * Audio arrives in whatever frame size the transport sends; Silero needs exactly
 * VAD_WINDOW_SAMPLES at a time, so this buffers the remainder between pushes.
 */
export class VoiceActivity {
  /**
   * @param {object} args
   * @param {object} args.sherpa   the loaded sherpa-onnx module
   * @param {object} args.config   engine.vadConfig (model path)
   */
  constructor({ sherpa, config }) {
    this.vad = new sherpa.Vad(
      {
        ...config,
        sileroVad: {
          ...config.sileroVad,
          threshold: VAD.threshold,
          minSilenceDuration: VAD.minSilenceSeconds,
          minSpeechDuration: VAD.minSpeechSeconds,
          maxSpeechDuration: VAD.maxSpeechSeconds,
          windowSize: VAD_WINDOW_SAMPLES,
        },
      },
      // Internal ring buffer, in seconds: comfortably more than one maximal utterance.
      VAD.maxSpeechSeconds + 10
    );
    this.pending = new Float32Array(0);
    this.speaking = false;
    this.speechSamples = 0;
    // Same span as the detector's own buffer, so an utterance that is still open can always be completed.
    this.history = new SampleHistory((VAD.maxSpeechSeconds + 10) * SAMPLE_RATE);
    /** Where the previous utterance ended (absolute): a pre-roll never reaches back into it. */
    this.lastEnd = 0;
  }

  /**
   * Feed audio (16 kHz float32). Returns what happened during it, in order.
   *
   * @param {Float32Array} samples
   * @returns {Array<{type: "start"} | {type: "ongoing", speechMs: number} | {type: "utterance", samples: Float32Array, durationMs: number, prerollMs: number}>}
   */
  push(samples) {
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);

    const events = [];
    let offset = 0;
    for (; offset + VAD_WINDOW_SAMPLES <= merged.length; offset += VAD_WINDOW_SAMPLES) {
      const window = merged.subarray(offset, offset + VAD_WINDOW_SAMPLES);
      this.history.push(window);
      this.vad.acceptWaveform(window);

      const detected = this.vad.isDetected();
      if (detected && !this.speaking) {
        this.speaking = true;
        this.speechSamples = 0;
        events.push({ type: "start" });
      }
      if (detected) {
        this.speechSamples += VAD_WINDOW_SAMPLES;
        events.push({ type: "ongoing", speechMs: Math.round((this.speechSamples / SAMPLE_RATE) * 1000) });
      }

      // A finished utterance is queued once the trailing silence has elapsed.
      while (!this.vad.isEmpty()) {
        const segment = this.vad.front(false);
        this.vad.pop();
        this.speaking = false;
        // PRE-ROLL: the detector needs a moment of speech before it believes it, so a segment starts
        // a little AFTER the first word (measured on phone audio: ~200 ms of "What are" lost when the
        // caller spoke from the first sample). Give back the audio just before it — never reaching into
        // the previous utterance, and nothing if the position is unknown.
        const begin = Number.isFinite(segment.start) ? segment.start : null;
        const preroll =
          begin === null ? new Float32Array(0) : this.history.slice(Math.max(begin - PREROLL_SAMPLES, this.lastEnd), begin);
        const body = segment.samples;
        if (begin !== null) this.lastEnd = begin + body.length;
        // Copied: front(false) already returns an owned array, but the copy makes the
        // lifetime obvious — the session keeps it across awaits.
        const samples = new Float32Array(preroll.length + body.length);
        samples.set(preroll);
        samples.set(body, preroll.length);
        events.push({
          type: "utterance",
          samples,
          // The speech itself: the pre-roll is context for the recogniser, not speech the caller said.
          durationMs: Math.round((body.length / SAMPLE_RATE) * 1000),
          prerollMs: Math.round((preroll.length / SAMPLE_RATE) * 1000),
        });
      }
    }

    this.pending = merged.slice(offset);
    return events;
  }

  /** Forget everything buffered — the call ended. */
  reset() {
    this.vad.reset();
    this.pending = new Float32Array(0);
    this.speaking = false;
    this.history.clear();
    this.lastEnd = 0;
  }
}
