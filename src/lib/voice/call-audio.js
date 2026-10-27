import { resample } from "./audio";

/**
 * THE AUDIO OF ONE CALL, on one timeline — the caller on the left channel, the agent on the right —
 * built up while the call runs and written out as a stereo WAV when it ends (CLAUDE.md §6.30).
 * Only a PHONE call is recorded, and only while the agent's recording switch is on (session.js decides);
 * the greeting says so in the same words, because both read the same switch (§6.24).
 *
 * WHY TWO TRACKS. A single mixed track cannot tell who said what when they talk over each other
 * (barge-in), and a person reviewing a call needs exactly that.
 *
 * THE TIMELINE. Telephone audio is a continuous stream, so the caller's samples are simply appended.
 * The agent's are placed where the caller would HEAR them: a sentence is sent whole and plays after
 * whatever is already queued (the same estimate session.js uses for "the agent is talking"), and a
 * barge-in throws the queued rest away (`cut`) — so the recording holds what was actually heard, not
 * what was synthesised.
 *
 * RATE. 8 kHz, the phone network's own. The caller's track arrives at 16 kHz having been up-sampled from
 * 8 kHz μ-law (audio.js createUpsampler2, a sinc interpolator that keeps the original samples exactly at
 * the even positions), so taking every second sample gives the original back — which is only true for
 * a source already limited to 4 kHz, hence phone calls only. The agent's voice is down-sampled with the
 * low-pass of audio.js `resample`.
 *
 * MEMORY. 16-bit samples; the longest call (LIMITS.maxCallMs, 15 min) is ~29 MB of WAV. A track stops
 * growing at MAX_SECONDS, which can only be reached by a call longer than the limit allows.
 *
 * Pure: the clock is injected, nothing here touches disk or network (tests/call-audio.test.mjs).
 */

export const RECORDING_RATE = 8_000;
const MAX_SECONDS = 20 * 60;

export class CallAudioRecorder {
  /** @param {{now?: () => number}} [options]  milliseconds, any monotonic clock */
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.startedAt = now();
    /** @type {Int16Array[]} caller chunks at the recording rate, in order */
    this.callerChunks = [];
    this.callerLength = 0;
    /** @type {Array<{at: number, pcm: Int16Array}>} agent pieces by position (samples at the recording rate) */
    this.agentPieces = [];
    this.agentEnd = 0;
  }

  /** Samples since the call began, at the recording rate. */
  position() {
    return Math.max(0, Math.round(((this.now() - this.startedAt) / 1000) * RECORDING_RATE));
  }

  /**
   * The caller's audio, 16 kHz float32 as the session receives it.
   * @param {Float32Array} samples
   */
  caller(samples) {
    const wanted = Math.floor(samples.length / 2);
    if (!wanted || this.callerLength + wanted > MAX_SECONDS * RECORDING_RATE) return;
    const pcm = new Int16Array(wanted);
    for (let i = 0; i < wanted; i++) pcm[i] = toPcm16(samples[i * 2]);
    this.callerChunks.push(pcm);
    this.callerLength += wanted;
  }

  /**
   * A piece of the agent's voice, as sent to the caller: it plays after whatever is already queued.
   * @param {Float32Array} samples
   * @param {number} sampleRate
   */
  agent(samples, sampleRate) {
    if (!samples.length) return;
    const at = Math.max(this.position(), this.agentEnd);
    const phone = sampleRate === RECORDING_RATE ? samples : resample(samples, sampleRate, RECORDING_RATE);
    if (at + phone.length > MAX_SECONDS * RECORDING_RATE) return;
    const pcm = new Int16Array(phone.length);
    for (let i = 0; i < phone.length; i++) pcm[i] = toPcm16(phone[i]);
    this.agentPieces.push({ at, pcm });
    this.agentEnd = at + pcm.length;
  }

  /** Barge-in: what had not played yet never will. */
  cut() {
    const here = this.position();
    this.agentPieces = this.agentPieces
      .filter((piece) => piece.at < here)
      .map((piece) => (piece.at + piece.pcm.length > here ? { at: piece.at, pcm: piece.pcm.subarray(0, here - piece.at) } : piece));
    this.agentEnd = Math.min(this.agentEnd, here);
  }

  /** Seconds of audio recorded so far (the longer of the two tracks). */
  seconds() {
    return Math.max(this.callerLength, this.agentEnd) / RECORDING_RATE;
  }

  /**
   * The finished recording.
   * @returns {Buffer|null}  a stereo 16-bit WAV, or null when there is nothing in it
   */
  toWav() {
    const length = Math.max(this.callerLength, this.agentEnd);
    if (!length) return null;
    const left = new Int16Array(length);
    let at = 0;
    for (const chunk of this.callerChunks) {
      left.set(chunk, at);
      at += chunk.length;
    }
    const right = new Int16Array(length);
    for (const piece of this.agentPieces) right.set(piece.pcm, piece.at);
    return encodeStereoWav(left, right, RECORDING_RATE);
  }
}

function toPcm16(sample) {
  const clipped = Math.max(-1, Math.min(1, sample));
  return Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff);
}

/**
 * @param {Int16Array} left
 * @param {Int16Array} right  same length
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function encodeStereoWav(left, right, sampleRate) {
  const frames = left.length;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(left[i], i * 4);
    data.writeInt16LE(right[i], i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // stereo
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28); // byte rate
  header.writeUInt16LE(4, 32); // block align
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
