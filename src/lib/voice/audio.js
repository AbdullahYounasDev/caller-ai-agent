/**
 * PCM CONVERSIONS — the only audio maths the gateway does. Pure (tests/voice-audio.test.mjs).
 *
 * Inside the gateway everything is float32 in [-1, 1] (what sherpa-onnx takes and
 * returns); on the wire it is 16-bit little-endian PCM, half the bytes. A Twilio
 * transport will add μ-law ⇄ PCM and an 8 kHz ⇄ 16 kHz resample here, at the edge.
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
