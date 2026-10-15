/**
 * VOICE TUNABLES — every number that shapes how a call feels, in one place.
 *
 * Most of these trade LATENCY against ROBUSTNESS, and each comment says which way.
 * Change them deliberately, with a call or two to listen to, and keep the reasoning
 * next to the value — the same rule as MAX_DISTANCE (§6.3), for the same reason: a
 * number tuned by feel quietly makes the product worse.
 */

/** Every audio buffer inside the gateway is 16 kHz mono float32: what Silero VAD and
 *  Parakeet were trained on. Transports convert at the edge (the browser sends 16 kHz
 *  PCM16 already; Twilio will send 8 kHz μ-law). */
export const SAMPLE_RATE = 16_000;

/** Silero's analysis window at 16 kHz. Fixed by the model. */
export const VAD_WINDOW_SAMPLES = 512;

export const VAD = {
  /** Speech probability above which a window counts as speech. 0.5 is Silero's
   *  default; higher ignores more background noise but clips soft speakers. */
  threshold: 0.5,

  /**
   * ⚠️ THE BIGGEST LATENCY KNOB IN THE WHOLE PIPELINE. How much silence ends the
   * caller's turn. Every turn waits this long before anything else can start, so it is
   * paid on EVERY response. Shorter feels snappier but cuts off a caller who pauses
   * mid-sentence ("I'd like to know… the price of the Pro plan"); 0.5 s is where
   * commercial voice agents usually sit.
   */
  minSilenceSeconds: 0.5,

  /** Shorter bursts (a cough, a click, a door) are not speech. */
  minSpeechSeconds: 0.25,

  /** A single utterance longer than this is force-split, so a caller reading a long
   *  address does not hold the turn — and the STT's memory — forever. */
  maxSpeechSeconds: 20,
};

export const BARGE_IN = {
  /**
   * How long the caller must keep talking over the agent before the agent stops.
   * Stopping on the first speech frame makes the agent cut itself off at every
   * "mm-hm", cough, or leak of its own voice through the speakers; waiting too long
   * makes it talk over people. 350 ms is long enough to ignore a backchannel, short
   * enough to feel like the agent is listening.
   */
  minSpeechMs: 350,
};

export const LIMITS = {
  /** Hard ceiling on one call. Protects the shared model quota from a forgotten tab. */
  maxCallMs: 15 * 60_000,
  /** No caller speech for this long ends the call. */
  idleMs: 90_000,
  /** Calls one tenant may hold at once — local models share this machine's CPU. */
  maxConcurrentCallsPerTenant: 3,
  /** Calls the whole gateway serves at once. A CPU budget, not a business rule: each
   *  call runs speech models on this machine. Raise it on a bigger server (§9.2). */
  maxConcurrentCalls: 6,
  /** A transcript shorter than this is noise the VAD let through, not a question. */
  minTranscriptChars: 2,
  /** How long a signed session ticket stays usable to OPEN a socket. */
  sessionTicketTtlMs: 60_000,
};

export const FILLER = {
  /**
   * If a turn has produced no reply audio this long after the caller stopped talking,
   * the agent says a short holding line (prompt.js voiceLine "filler"). Silence past a
   * few seconds on a phone line reads as a dropped call. Set to null to disable.
   *
   * It is a symptom detector, not a feature: it fires when the LLM is slow, and on the
   * free Gemini tier the first token takes 3.5–10 s on EVERY model (measured, §6.24) —
   * so it fired on every turn, including "what are your hours?", and callers heard it
   * as the agent stalling on simple questions. Raised from 1.8 s to 2.5 s, and it is now
   * skipped whenever the answer has already started (session.js scheduleFiller) — so it
   * only fires when the model has produced nothing at all. The real fix is a fast LLM
   * endpoint (Groq, §6.24).
   */
  afterMs: 2500,
};

export const TTS = {
  /** Speaking rate. 1.0 is each voice's natural pace. It used to be 1.05 ("phone agents
   *  sound better a touch quicker") — callers heard it as rushed. Do not raise it
   *  without listening to a call. */
  speed: 1.0,
  /** Silence after every synthesised sentence, so separately synthesised sentences do
   *  not run into each other (tts.js). */
  sentencePauseMs: 160,
};

/** The gateway's own port. The browser connects to it directly (Next.js route
 *  handlers cannot hold a WebSocket open, §6.24). */
export function gatewayPort(env = process.env) {
  return Number(env.VOICE_GATEWAY_PORT) || 3001;
}
