/**
 * MICROPHONE CAPTURE — runs on the browser's audio thread (AudioWorklet).
 *
 * Takes the microphone at whatever rate the device runs (44.1 / 48 kHz), downsamples to
 * the 16 kHz the gateway's VAD and STT expect, converts to 16-bit PCM and posts one
 * 20 ms frame (320 samples) at a time to the page, which sends it straight down the
 * WebSocket. Doing this here rather than on the main thread means a busy page (React
 * re-rendering the transcript) can never make the caller's audio stutter.
 *
 * Downsampling averages every input sample that falls inside one output sample — a
 * box filter. Crude next to a proper polyphase filter, but it removes most of the
 * aliasing that plain decimation would add, costs nothing, and speech recognisers are
 * forgiving of it.
 *
 * Lives in /public because addModule() loads it by URL; it cannot be bundled.
 */
const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in the AudioWorklet scope: the context's rate.
    this.ratio = sampleRate / TARGET_RATE;
    this.position = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
    this.energy = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i];
      this.count++;
      this.position += 1;
      if (this.position < this.ratio) continue;

      this.position -= this.ratio;
      const value = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      this.energy += value * value;

      const clamped = Math.max(-1, Math.min(1, value));
      this.frame[this.filled++] = clamped < 0 ? clamped * 32768 : clamped * 32767;

      if (this.filled === FRAME_SAMPLES) {
        const level = Math.sqrt(this.energy / FRAME_SAMPLES);
        // Transferred, not copied: a fresh array is allocated for the next frame.
        this.port.postMessage({ pcm: this.frame.buffer, level }, [this.frame.buffer]);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.filled = 0;
        this.energy = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCapture);
