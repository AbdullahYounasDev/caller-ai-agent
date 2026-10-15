/**
 * PLAYS THE AGENT'S VOICE — PCM16 chunks from the gateway, back to back, gaplessly.
 *
 * Each chunk (one sentence from the gateway) becomes an AudioBufferSourceNode scheduled
 * to start exactly when the previous one ends, so sentences synthesised separately still
 * sound like one continuous reply. clear() stops everything at once — that is barge-in
 * on the client side, and it must be instant.
 *
 * Reports "playing" / "stopped" transitions so the gateway knows when the agent is
 * actually audible (the agent is "speaking" until the caller has HEARD the audio, not
 * merely received it).
 */
export class PcmPlayer {
  /**
   * @param {AudioContext} context
   * @param {(playing: boolean) => void} onPlayingChange
   */
  constructor(context, onPlayingChange) {
    this.context = context;
    this.onPlayingChange = onPlayingChange;
    this.sampleRate = 22050;
    this.nextStart = 0;
    this.sources = new Set();
    this.playing = false;

    this.output = context.createGain();
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.output.connect(this.analyser);
    this.output.connect(context.destination);
    this.levelBuffer = new Float32Array(this.analyser.fftSize);
  }

  setFormat(sampleRate) {
    this.sampleRate = sampleRate;
  }

  /** @param {ArrayBuffer} pcm16  little-endian 16-bit mono at the current format's rate */
  enqueue(pcm16) {
    const view = new DataView(pcm16);
    const count = pcm16.byteLength >> 1;
    if (!count) return;

    const buffer = this.context.createBuffer(1, count, this.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) data[i] = view.getInt16(i * 2, true) / 32768;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);

    // A small lead on the first chunk, so it is never scheduled in the past.
    const startAt = Math.max(this.nextStart, this.context.currentTime + 0.03);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;

    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (!this.sources.size) this.setPlaying(false);
    };
    this.setPlaying(true);
  }

  /** Stop everything now and forget what was queued. */
  clear() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.nextStart = 0;
    this.setPlaying(false);
  }

  /** Current output loudness, 0–1, for the level meter. */
  level() {
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const v of this.levelBuffer) sum += v * v;
    return Math.sqrt(sum / this.levelBuffer.length);
  }

  setPlaying(playing) {
    if (this.playing === playing) return;
    this.playing = playing;
    this.onPlayingChange(playing);
  }
}
