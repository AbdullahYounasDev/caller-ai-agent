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
