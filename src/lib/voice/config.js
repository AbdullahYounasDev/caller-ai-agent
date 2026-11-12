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
 *  PCM16 already; Twilio sends 8 kHz μ-law). */
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

  /**
   * Audio given back from BEFORE the detector's own start of an utterance (speech/vad.js). The detector
   * needs a moment of speech to believe it, so on phone audio with the caller already talking at the
   * first sample it started ~200 ms in and the recogniser heard "your opening hours." for "What are
   * your opening hours?" (voice smoke, no lead-in). 300 ms covers that with room; more would only
   * feed the recogniser the line noise before the word. Costs no latency: it is audio already received.
   * ⚠️ Whether 300 ms is right for REAL calls (carrier noise, soft speakers) is a listening question.
   */
  prerollMs: 300,
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

/**
 * THE ECHO GUARD (echo-guard.js): tells the agent's own voice, coming back through the caller's speaker and
 * microphone, from a person talking. The numbers are the matching rules; the first set was chosen on synthetic
 * loopback (npm run voice:echo) — real speakerphones are a listening job, like every number in this file.
 * Every doubt answers "not an echo" (fail open), so a wrong value here can only bring back today's behaviour.
 */
export const ECHO_GUARD = {
  /** One envelope step. */
  frameMs: 10,
  /** The loudness floor (rms, full scale = 1): −50 dBFS. Quieter than this is the room, not speech. */
  floor: 0.003,
  /** How far behind the agent's audio the echo may arrive: speaker + room + network + the client's buffer. */
  minLagMs: -60,
  maxLagMs: 900,
  /** Least frames compared (10 ms each): too few and any two signals can look alike. */
  minWindowFrames: 30,
  /** The agent's audio must be audible for at least this many frames (10 ms each) of the window, at the lag asked about. */
  minReferenceFrames: 20,
  /** A flat envelope (steady noise, a held tone) carries no pattern to match. */
  minVariance: 0.05,
  /** A window this quiet (mean rms, −44 dBFS) with nothing moving holds no speech at all. */
  quietRms: 0.01,
  /** STEP 1, learning the echo path: a long window (frames), searched over every delay, must match this well. */
  minLearnFrames: 60,
  /** …and the agent must have been audible for this many frames (10 ms each) of it, at the delay tried. */
  learnMinActiveFrames: 60,
  learnWindowFrames: 250,
  learnCorrelation: 0.85,
  relearnEveryFrames: 30,
  /** The path is also learned while the agent speaks (and for this many frames after its audio ended). */
  learnWhileRecentFrames: 150,
  /** An echo path not confirmed for this long (frames) is forgotten — the phone was moved, headphones plugged in. */
  forgetAfterFrames: 2000,
  /** STEP 2, asking at the learned delay (± this many frames): a modest match is strong evidence with nothing to search. */
  lagToleranceFrames: 3,
  /** Pearson correlation of the two log-loudness patterns needed to call it an echo, at the known delay. */
  minCorrelation: 0.55,
  /** The microphone may be at most this many times louder than the echo explains, and only for this share of its energy. */
  residualMargin: 1.6,
  maxResidual: 0.35,
  /** The echo's tail after the agent stopped (end of a sentence): how far back to look for agent audio, how much
   *  of it must have been there, and how much a microphone may RISE (ratio of the last 200 ms to the first) and
   *  still be a decaying tail. */
  tailLookBackMs: 800,
  tailMinFrames: 5,
  tailRisingRatio: 1.2,
  /** The echo's size may be up to this many times the size learned (+8 dB) before it is taken for a louder sound. */
  gainDrift: 2.5,
  /** An echo is quieter than the source (the microphone may amplify: AGC) — above this the match is a coincidence. */
  maxGain: 3,
  /** A whole utterance is judged in windows of this many frames (1.5 s), half-overlapping; all must be echo to drop it. */
  spanWindowFrames: 150,
  /** …and a sound heard before the guard has had enough of the agent's audio to look for an echo path at all (the
   *  first second or so of the call's first words) may wait this long: either it is judged an echo, or the guard
   *  finds there is none (headphones) and the agent is interrupted as before. */
  coldGraceMs: 1500,
  /** While the agent is between two sentences (nothing to compare with yet) a sound may wait this long to become decidable. */
  undecidedGraceMs: 400,
  /** At a barge-in the question covers this much of the latest speech. */
  bargeWindowMs: 600,
};

export const LIMITS = {
  /** Hard ceiling on one call. Protects the shared model quota from a forgotten tab. */
  maxCallMs: 15 * 60_000,
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

/**
 * SILENCE ON THE LINE. The agent never hangs up on someone without asking first:
 *   caller silent for `checkInAfterMs`  →  the agent asks "Are you still there?"
 *   still silent `endAfterCheckInMs` later  →  it says a polite goodbye and ends the call.
 * Any sound from the caller at any point cancels both (it is measured from the end of whatever
 * the agent last said, never while the agent is speaking or thinking). A caller who hangs up
 * themselves is simply the end of the call; none of this runs.
 *
 * 15 s is long enough for someone looking up an address or a card number and short enough that
 * a dropped line is noticed; the second window gives a real person time to answer a question.
 */
export const SILENCE = {
  checkInAfterMs: 15_000,
  endAfterCheckInMs: 10_000,
  /**
   * After the caller asked the agent to wait ("hold on, let me find my card", "ek minute" —
   * lib/phrases PAUSES): someone fetching a card or a diary needs more than 15 s, and asking
   * "are you still there?" at them sounds impatient. Back to normal at their next real message.
   */
  hold: { checkInAfterMs: 60_000, endAfterCheckInMs: 20_000 },
};

// ENDING A CALL THAT HAS COME TO ITS CONCLUSION is decided in ./closing.js, and the quiet before
// it ends is each agent's own setting (agent_configs.end_call_delay_seconds, 2–10 s, default 3).

/**
 * Speech the recogniser could not turn into words: the caller DID talk (this long) and we got
 * nothing. Short blips are noise (a cough, a click); anything longer is a person we failed to
 * hear, and ignoring them in silence is the worst thing an agent can do.
 */
export const UNHEARD = {
  minSpeechMs: 1_000,
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

export const CONTINUATION = {
  /**
   * A transcript that stops mid-thought ("I want to book an appointment with…", ending on a
   * joining word or a comma) is held this long, after the 0.5 s of silence that already
   * ended the turn, to see whether the caller carries on. If they do, the two halves are
   * ONE message; if not, the held half is answered as usual. Only unfinished-looking
   * transcripts pay it (voice/transcript-clean.js looksUnfinished) — a complete sentence
   * never waits. 1.2 s covers the pause people actually take to find a word; longer makes a
   * caller who really did stop wait for nothing.
   */
  holdMs: 1200,
  /** Halves that may be joined into one message. */
  maxMerges: 2,
  /**
   * The LATE merge, for a sentence that did not LOOK unfinished ("I want to book an appointment."
   * … "for tomorrow at five"): when the caller starts speaking again within this long of the end of
   * the previous utterance AND has not heard a word of the answer yet, the turn in flight is
   * withdrawn (its writes undone — respond.js `signal`) and both halves are answered as one message.
   * It costs a finished sentence nothing: no turn waits for it. Once the agent has spoken, speech is
   * an ordinary interruption (BARGE_IN). 3 s: past that, a caller who speaks into the silence is
   * more likely saying "hello?" than finishing a sentence.
   */
  lateMergeWithinMs: 3000,
};

export const TTS = {
  /** Speaking rate. 1.0 is each voice's natural pace. It used to be 1.05 ("phone agents
   *  sound better a touch quicker") — callers heard it as rushed. Do not raise it
   *  without listening to a call. */
  speed: 1.0,
  /**
   * THE PAUSE AT EACH JOIN between two separately synthesised pieces (tts.js, sentences.js
   * chunkEnding). The engine's own quiet at both ends is trimmed first (`trim`), so these are
   * the pauses the caller actually hears, plus the ~60 ms `trim` keeps.
   *   after a sentence   a breath, as a person leaves one (it was 160 ms ON TOP of ~150 ms of
   *                      engine quiet; 240 + the kept 60 ≈ the same ~300 ms rhythm as before);
   *   at a comma         shorter;
   *   inside a sentence  none: the next piece follows straight on. This is the fix for "tell me
   *                      about …… your name" — that join used to carry ~300 ms of silence before
   *                      any synthesis delay was added to it.
   */
  sentencePauseMs: 240,
  commaPauseMs: 120,
  joinPauseMs: 0,
  /**
   * Trimming the engine's own silence at the start and end of every piece (audio.js
   * trimSilence). Measured on this repo's voices (2% of peak, 10 ms windows): Kokoro leaves
   * 50–100 ms before and 70–90 ms after each piece, Piper up to 190 ms after. 20 ms / 40 ms are
   * kept so a soft first or last sound is never clipped. null turns trimming off.
   */
  trim: { relative: 0.02, keepLeadMs: 20, keepTailMs: 40 },
  /**
   * A call whose speech is made about as slowly as it plays cannot avoid gaps by chunking — every
   * piece takes longer to make than the one before it takes to play. Above this ratio (synthesis
   * time ÷ audio time, a running average over the call) the call logs `tts.slow` once, so its
   * timeline says why it had gaps. Measured: Kokoro ~0.57 on an idle laptop, ~1.2 on battery with
   * the browser busy (§6.24). The fixes are the fast voice or the speech server (§9.2) — speaking
   * whole sentences was measured and made it worse (sentences.js).
   */
  slowRatio: 0.9,
  /** A wait between two pieces of one reply longer than this is logged as `tts.gap` (the caller heard it). */
  gapLogMs: 120,
};

/**
 * THE FAST START (voices.js, session.js): the first piece of an English reply is made by the fast
 * (Piper) voice that matches the agent's, and the rest by the voice the owner chose. It cuts the wait
 * for the first sound by about a second, at the price of a second voice in the first couple of seconds
 * of a reply — a trade nobody has LISTENED to yet (CLAUDE.md §6.24), so it is OFF unless
 * VOICE_FAST_FIRST_CHUNK is 1, true or on. The same precedent as TTS.speed above: "do not change
 * it without listening to a call".
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function fastFirstChunkEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env.VOICE_FAST_FIRST_CHUNK ?? "").trim());
}

/**
 * THE ECHO GUARD is ON unless VOICE_ECHO_GUARD is 0, false, off or no. Unlike the fast start it can be on by
 * default because its failure mode is measured and one-sided: it only ever answers "the agent's own voice"
 * when the microphone provably follows what the agent just played, every doubt keeps today's behaviour, and
 * with headphones it does nothing (npm run voice:echo). The switch exists for the day a real room says otherwise.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function echoGuardEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.VOICE_ECHO_GUARD ?? "").trim());
}

/** The gateway's own port. The browser connects to it directly (Next.js route
 *  handlers cannot hold a WebSocket open, §6.24). */
export function gatewayPort(env = process.env) {
  return Number(env.VOICE_GATEWAY_PORT) || 3001;
}
