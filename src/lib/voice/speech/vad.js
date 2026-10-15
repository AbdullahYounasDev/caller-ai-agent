import { VAD, VAD_WINDOW_SAMPLES, SAMPLE_RATE } from "../config";

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
  }

  /**
   * Feed audio (16 kHz float32). Returns what happened during it, in order.
   *
   * @param {Float32Array} samples
   * @returns {Array<{type: "start"} | {type: "ongoing", speechMs: number} | {type: "utterance", samples: Float32Array, durationMs: number}>}
   */
  push(samples) {
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);

    const events = [];
    let offset = 0;
    for (; offset + VAD_WINDOW_SAMPLES <= merged.length; offset += VAD_WINDOW_SAMPLES) {
      this.vad.acceptWaveform(merged.subarray(offset, offset + VAD_WINDOW_SAMPLES));

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
        events.push({
          type: "utterance",
          // Copied: front(false) already returns an owned array, but the copy makes the
          // lifetime obvious — the session keeps it across awaits.
          samples: Float32Array.from(segment.samples),
          durationMs: Math.round((segment.samples.length / SAMPLE_RATE) * 1000),
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
  }
}
