/**
 * PCM CONVERSIONS — the only audio maths the gateway does. Pure (tests/voice-audio.test.mjs).
 *
 * Inside the gateway everything is float32 in [-1, 1] (what sherpa-onnx takes and
 * returns); on the wire it is 16-bit little-endian PCM, half the bytes. A phone line
 * (Twilio Media Streams, transports/twilio.js) carries 8 kHz μ-law instead, so this file also
 * holds the conversion at that edge: μ-law ⇄ float32 and the resampling between 8 kHz and the
 * 16 kHz the speech models use (and whatever rate the voice synthesises at).
 */

/**
 * @param {Buffer|ArrayBuffer|Uint8Array} data  PCM16 little-endian
 * @returns {Float32Array}
 */
export function pcm16ToFloat32(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const count = bytes.byteLength >> 1; // a trailing odd byte is not a sample
  // DataView reads little-endian regardless of alignment — a Buffer from a socket can
  // start at an odd byteOffset, which an Int16Array view over it would reject.
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/**
 * A complete WAV file (RIFF, PCM16 mono) — what a hosted transcription API accepts as an
 * upload (speech/stt.js, Groq Whisper).
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function encodeWav(samples, sampleRate) {
  const pcm = float32ToPcm16(samples);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * @param {Float32Array} samples
 * @returns {Buffer}  PCM16 little-endian
 */
export function float32ToPcm16(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), i * 2);
  }
  return out;
}

/**
 * Cut the near-silence a TTS engine leaves at the start and end of every piece it speaks
 * (sentences.js cuts a reply into pieces). Each piece is synthesised on its own, so that
 * silence is paid at EVERY join — inside a sentence it reads as the agent stopping mid-thought.
 * The session then adds back exactly the pause the join needs (TTS in config.js).
 *
 * Speech is found by short-window energy: a window counts as speech when its RMS reaches
 * `relative` × the loudest window (or `floor`, whichever is higher). A little of the quiet is
 * kept on each side (`keepLeadMs`, `keepTailMs`), so a soft first or last sound ("s", "f",
 * "h") is never clipped. Audio with no window above the threshold is returned unchanged.
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {{relative?: number, floor?: number, keepLeadMs?: number, keepTailMs?: number, windowMs?: number}} [options]
 * @returns {{samples: Float32Array, leadMs: number, tailMs: number}} what was kept, and how much was cut from each end
 */
export function trimSilence(samples, sampleRate, { relative = 0.02, floor = 0.002, keepLeadMs = 20, keepTailMs = 40, windowMs = 5 } = {}) {
  const win = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const windows = Math.floor(samples.length / win);
  if (!windows) return { samples, leadMs: 0, tailMs: 0 };
  const rms = new Float32Array(windows);
  let peak = 0;
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    for (let i = w * win; i < (w + 1) * win; i++) sum += samples[i] * samples[i];
    rms[w] = Math.sqrt(sum / win);
    if (rms[w] > peak) peak = rms[w];
  }
  const threshold = Math.max(peak * relative, floor);
  let first = 0;
  while (first < windows && rms[first] < threshold) first++;
  if (first === windows) return { samples, leadMs: 0, tailMs: 0 };
  let last = windows - 1;
  while (last > first && rms[last] < threshold) last--;

  const start = Math.max(0, first * win - Math.round((sampleRate * keepLeadMs) / 1000));
  const end = Math.min(samples.length, (last + 1) * win + Math.round((sampleRate * keepTailMs) / 1000));
  return {
    samples: start === 0 && end === samples.length ? samples : samples.slice(start, end),
    leadMs: Math.round((start / sampleRate) * 1000),
    tailMs: Math.round(((samples.length - end) / sampleRate) * 1000),
  };
}

/**
 * `samples` followed by `ms` of silence.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} ms
 */
export function withTrailingSilence(samples, sampleRate, ms) {
  const pad = Math.round((sampleRate * Math.max(0, ms)) / 1000);
  if (!pad) return samples;
  const out = new Float32Array(samples.length + pad);
  out.set(samples);
  return out;
}

// ── the phone edge: G.711 μ-law and 8 kHz ⇄ 16 kHz (CLAUDE.md §6.24, transports/twilio.js) ──────────

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32_635;

/** One 16-bit sample to one μ-law byte (ITU-T G.711). */
function linearToMulaw(sample) {
  const sign = (sample >> 8) & 0x80;
  let magnitude = sign ? -sample : sample;
  if (magnitude > MULAW_CLIP) magnitude = MULAW_CLIP;
  magnitude += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** The 256 μ-law bytes as float32 — decoding is a table lookup. */
const MULAW_TO_FLOAT = Float32Array.from({ length: 256 }, (_, byte) => {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return (u & 0x80 ? -magnitude : magnitude) / 32768;
});

/**
 * @param {Buffer|Uint8Array} bytes  μ-law, one byte per sample
 * @returns {Float32Array}
 */
export function mulawToFloat32(bytes) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_TO_FLOAT[bytes[i]];
  return out;
}

/**
 * @param {Float32Array} samples  in [-1, 1]
 * @returns {Buffer} μ-law, one byte per sample
 */
export function float32ToMulaw(samples) {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = linearToMulaw(Math.round(s < 0 ? s * 32768 : s * 32767));
  }
  return out;
}

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/**
 * Change the sample rate of a WHOLE piece of audio (a sentence the voice just synthesised) with a
 * windowed-sinc filter: the low-pass is part of the filter, so going from 22–24 kHz down to a
 * phone's 8 kHz does not fold high frequencies back into the voice as a metallic hiss, which
 * plain decimation or linear interpolation would. Pieces are resampled one at a time; they start
 * and end in silence (trimSilence), so the edges are not heard.
 *
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const cutoff = Math.min(1, toRate / fromRate) * 0.97; // × the input's Nyquist
  const half = Math.ceil(12 / cutoff); // 12 zero crossings each side
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const t = i * ratio;
    const centre = Math.floor(t);
    let sum = 0;
    for (let n = Math.max(0, centre - half + 1); n <= Math.min(samples.length - 1, centre + half); n++) {
      const x = t - n;
      const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / (half + 1)); // Hann
      sum += samples[n] * cutoff * sinc(cutoff * x) * window;
    }
    out[i] = sum;
  }
  return out;
}

/**
 * 8 kHz → 16 kHz for a LIVE stream: 20 ms frames arrive one at a time, so the filter keeps the
 * end of the previous frame (and delays the output by a few samples, ~1 ms) instead of treating
 * each frame as a separate piece — which would put a click at every frame edge.
 *
 * @returns {{push: (samples: Float32Array) => Float32Array}}
 */
export function createUpsampler2() {
  const TAPS = 8; // input samples each side of the point being interpolated
  const kernel = Float32Array.from({ length: TAPS * 2 }, (_, k) => {
    const x = k - TAPS + 1 - 0.5; // distance from the half-sample position
    return sinc(x) * (0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS + 0.5)));
  });
  let history = new Float32Array(TAPS); // silence before the first sample
  return {
    push(samples) {
      const buffer = new Float32Array(history.length + samples.length);
      buffer.set(history);
      buffer.set(samples, history.length);
      const ready = buffer.length - TAPS; // outputs for positions that have TAPS samples after them
      const out = new Float32Array(Math.max(0, ready - TAPS) * 2);
      for (let n = TAPS; n < ready; n++) {
        const o = (n - TAPS) * 2;
        out[o] = buffer[n]; // the original sample
        let mid = 0; // the half-sample between n and n+1
        for (let k = 0; k < TAPS * 2; k++) mid += buffer[n - TAPS + 1 + k] * kernel[k];
        out[o + 1] = mid;
      }
      history = buffer.slice(Math.max(0, ready - TAPS));
      return out;
    },
  };
}
