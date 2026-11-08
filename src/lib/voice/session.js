import { createSerialQueue } from "./serial";
import { SentenceChunker, chunkEnding } from "./sentences";
import { chooseSpokenLanguage } from "./spoken-language";
import { classifyTurn, INTENTS, OUTCOMES } from "./intent";
import { median } from "./recorder";
import { CallAudioRecorder } from "./call-audio";
import { BARGE_IN, CONTINUATION, FILLER, LIMITS, SILENCE, TTS, UNHEARD, VAD } from "./config";
import { collapseRepeats, looksUnfinished } from "./transcript-clean";
import { CALL_STATES, END_REASONS, ERROR_CODES, SERVER } from "./protocol";
import { decideCallEnd } from "./closing";
import { SPOKEN_LANGUAGES, voiceFor } from "./speech/voices";
import { callVocabulary } from "./vocabulary";
import { detectPause } from "@/lib/phrases";
import { nextContactLine } from "@/lib/handoff/announce";
import { buildVoiceGreeting, voiceLine } from "@/lib/agent/prompt";

/** Allowance for the client's audio buffering and network jitter when estimating when
 *  playback ends. */
const PLAYBACK_SLACK_MS = 250;

/**
 * ONE LIVE CALL — the voice channel adapter of §1, and the only place that knows how a
 * spoken conversation flows:
 *
 *   answer → greet → listen ─► caller speaks ─► caller stops (VAD)
 *                      ▲                              │
 *                      │                     transcribe (STT seam)
 *                      │                              │
 *                      │        respond() — THE SAME BRAIN as the test chat: history,
 *                      │        conversation-aware retrieval, grounding, persistence
 *                      │                              │ streamed tokens
 *                      │                     sentence by sentence
 *                      │                              │
 *                      └──── playback ends ◄── speak (TTS seam)
 *
 * and, at any moment while the agent is thinking or speaking, BARGE-IN: the caller
 * talks over it for BARGE_IN.minSpeechMs → playback is cleared, the rest of the reply is
 * not spoken, and the turn is logged as interrupted.
 *
 * ── THE ONE-BRAIN RULE HOLDS ─────────────────────────────────────────────
 * This class does no retrieval, builds no prompt and calls no model. It turns audio into
 * a userMessage, hands it to respond() with channel "voice" (which selects the
 * voice-safe CHANNEL_STYLE in prompt.js), and turns the streamed reply back into audio.
 * A prompt or retrieval change shows up identically on a call and in the test chat.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * TRANSPORT-AGNOSTIC. It talks to its caller only through a `transport`:
 *     transport.audio(samples: Float32Array, sampleRate)   play this
 *     transport.clear()                                     stop playback now
 *     transport.notify(type, payload)                       live UI/telemetry (SERVER.*)
 *     transport.close(reason)                               hang up the connection
 * and is driven by it through onAudio(16 kHz float32), onPlayback(playing) and hangup().
 * The browser test console is one transport; Twilio will be another (§9.2).
 *
 * Every dependency is injected (speech engines, the brain, the recorder) so the whole
 * flow — barge-in, sentence pipelining, failures — is tested without models, a database
 * or a network (tests/voice-session.test.mjs).
 */
export class CallSession {
  /**
   * @param {object} args
   * @param {string} args.tenantId
   * @param {string|null} [args.agentId]       which agent answers (null = the default agent).
   *   With telephony this is the agent the dialled number points to (CLAUDE.md §6.27).
   * @param {{numberId?: string|null, toNumber?: string|null, fromNumber?: string|null}|null} [args.line]
   *   the phone line the call came in on (§6.29): which of the business's numbers was dialled, and
   *   by whom — recorded on the call. null for a plain console call.
   * @param {{conversationId: string, callId?: string|null, language?: string|null, count?: number}|null} [args.resume]
   *   this call is the same phone call COMING BACK from a transfer nobody answered (§6.30): it carries on
   *   the conversation, does not greet again, says nobody is available and can take a call-back
   * @param {"browser"|"twilio"} args.transportName
   * @param {object} args.transport            see above
   * @param {{forCall(call: {vocabulary?: string[]}): import("./speech/stt").Transcriber}} args.stt
   *   the STT seam; it picks the recogniser for this call (speech/stt.js)
   * @param {import("./speech/tts").TextToSpeech} args.tts
   * @param {() => {push: Function, reset: Function}} args.createVad
   * @param {object} args.engineInfo           stored on the call row
   * @param {object} args.brain                { respond, getAgentConfig, invalidateAgentConfig }
   * @param {(args: object) => Promise<object>} args.openRecorder   CallRecorder.open
   * @param {(args: {tenantId: string, callId: string, wav: Buffer}) => Promise<string|null>} [args.saveRecording]
   *   keeps a finished call's audio and returns the reference to store on the call (standins/recordings.js).
   *   Without it nothing is recorded. Used only for a PHONE call whose agent has recording switched on (§6.30).
   * @param {{now?: () => number, setTimeout?: Function, clearTimeout?: Function}} [args.clock]
   */
  constructor({ tenantId, agentId = null, line = null, resume = null, transportName, transport, stt, tts, createVad, engineInfo, brain, openRecorder, saveRecording = null, clock = {} }) {
    this.tenantId = tenantId;
    this.agentId = agentId;
    this.line = line;
    this.resume = resume;
    this.transportName = transportName;
    this.transport = transport;
    this.stt = stt;
    this.tts = tts;
    this.createVad = createVad;
    this.engineInfo = engineInfo;
    this.brain = brain;
    this.openRecorder = openRecorder;
    this.saveRecording = saveRecording;
    /** The call's audio while it is being recorded (voice/call-audio.js); null when this call is not recorded. */
    this.audio = null;
    this.now = clock.now ?? (() => performance.now());
    this.setTimer = clock.setTimeout ?? setTimeout;
    this.clearTimer = clock.clearTimeout ?? clearTimeout;

    this.state = CALL_STATES.CONNECTING;
    this.ended = false;
    this.turnQueue = createSerialQueue();
    this.turnIndex = 0;
    this.currentTurn = null;
    this.clientPlaying = false;
    this.bargedThisSpeech = false;
    this.interruptions = 0;
    this.responseTimes = [];
    this.lastLanguage = null;
    this.timers = {};
    this.holding = null;
    // Silence on the line: 0 = nothing said yet, 1 = the agent has asked "are you still there?".
    this.silenceStage = 0;
    // Speech the recogniser could not read, in a row (voice/config.js UNHEARD).
    this.unheardRun = 0;
    // The turn being worked on right now (from its transcription until its reply is sent), so a
    // caller who carries on talking before hearing anything can withdraw it (onUtterance).
    this.inflight = null;
    // What a withdrawn turn had heard: the next turn answers it together with what follows.
    this.carryOver = null;
    // When the caller last started speaking — how soon after the previous utterance they carried on.
    this.lastSpeechStartedAt = null;
    // The agent asked "are you still there?" and the caller has not said anything real since: a
    // plain "yes, I'm here" now answers THAT, not the conversation.
    this.checkInAsked = false;
    // "normal", or "hold" after the caller asked the agent to wait: the silence check-in waits longer.
    this.patience = "normal";
    // How much slower than real time this machine is making speech on this call (synthesis time ÷
    // audio time, a running average). Past TTS.slowRatio gaps cannot be avoided by chunking — the
    // call logs it once (`tts.slow`) so a slow machine is visible, not guessed at.
    this.ttsRatio = null;
    this.reportedSlow = false;
    // What the agent last said (as heard): did it just ask "anything else?" (lib/voice/closing.js).
    this.lastAgentReply = null;
    // The conversation is over and the call is about to end by itself ({trigger, delayMs}); cleared
    // by anything real the caller says, kept (and re-armed) through a cough or a click.
    this.closing = null;
    // When the last utterance ended: speech started after it and not yet ended = the caller is talking.
    this.lastUtteranceAt = null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Answer the call: load the business's config, open the record, greet. */
  async start() {
    try {
      // A call always starts on the business's CURRENT settings: the config cache is per
      // process (lib/tenant/config.js), and this process is not the one the dashboard
      // saved through.
      this.brain.invalidateAgentConfig(this.tenantId);
      this.config = await this.brain.getAgentConfig(this.tenantId, { agentId: this.agentId });
      // Archived after the ticket was issued: it no longer answers callers.
      if (this.config.status === "archived") throw new Error(`agent ${this.agentId} is archived`);
      // From here on the RESOLVED agent: "the default" becomes the default agent's id, so the
      // conversation keeps it even if the owner later makes another agent the default.
      this.agentId = this.config.agentId ?? null;

      // The engines THIS call uses, decided once: every call understands Urdu and English
      // whichever language it answers in, so the recogniser does not depend on the reply
      // language (speech/stt.js); each spoken language has the voice the business picked
      // (or its default). The business's own name is taught to the recogniser, which has
      // never heard it (vocabulary.js).
      this.transcriber = this.stt.forCall({ vocabulary: callVocabulary(this.config) });
      this.voices = Object.fromEntries(SPOKEN_LANGUAGES.map((lang) => [lang, voiceFor(this.config.voices, lang).id]));
      this.callEngine = { ...this.engineInfo, stt: this.transcriber.id, voices: this.voices };

      this.recorder = await this.openRecorder({
        tenantId: this.tenantId,
        agentId: this.agentId,
        transport: this.transportName,
        fromNumber: this.line?.fromNumber ?? null,
        toNumber: this.line?.toNumber ?? null,
        phoneNumberId: this.line?.numberId ?? null,
        conversationId: this.resume?.conversationId ?? null,
        engine: this.callEngine,
      });
      this.vad = this.createVad();
      if (this.shouldRecordAudio()) this.audio = new CallAudioRecorder({ now: this.now });
    } catch (err) {
      console.error("[voice] call setup failed:", err);
      this.transport.notify(SERVER.ERROR, { code: ERROR_CODES.INTERNAL, message: "Call setup failed" });
      this.transport.close(END_REASONS.SETUP_FAILED);
      this.ended = true;
      return false;
    }

    this.transport.notify(SERVER.READY, {
      callId: this.recorder.callId,
      conversationId: this.recorder.conversationId,
      engine: this.callEngine,
    });
    this.log("call.started", {
      transport: this.transportName,
      ...(this.line?.toNumber ? { toNumber: this.line.toNumber } : {}),
      ...(this.resume ? { resumedFromCallId: this.resume.callId ?? null, resumes: this.resume.count ?? 1 } : {}),
      replyLanguage: this.config.replyLanguage,
      stt: this.transcriber.id,
    });
    // Every call may be in Urdu, so a recogniser that cannot understand Urdu (no
    // GROQ_API_KEY — speech/stt.js) is worth a line in the timeline: the call still works
    // in English, and the first garbled Urdu transcript has its explanation right above it.
    if (!this.transcriber.understandsUrdu) {
      this.log("stt.urdu_unavailable", { stt: this.transcriber.id });
    }

    if (this.audio) this.log("recording.started", { reason: "the agent's recording switch is on" });
    this.timers.max = this.setTimer(() => this.end(END_REASONS.MAX_DURATION), LIMITS.maxCallMs);
    this.armIdleTimer();

    // The agent speaks first. A fixed line (prompt.js) — no model call, so the caller
    // hears someone pick up immediately. Its voice is loaded first (a no-op for the
    // default voices, which the gateway loads at start-up); the others load in the
    // background while the greeting plays.
    const greeting = this.resume ? await this.resumeLine() : buildVoiceGreeting(this.config);
    await this.tts.prepare([this.voices[greeting.language]]).catch(() => {});
    void this.tts.prepare(Object.values(this.voices)).catch(() => {});
    this.recorder.agentLine(greeting.text);
    this.lastLanguage = greeting.language;
    const turn = this.newTurn(0);
    this.currentTurn = turn;
    this.transport.notify(SERVER.AGENT_TEXT, { turn: 0, text: greeting.text });
    // Sentence by sentence, like a reply: the caller hears "Hello, thanks for calling
    // Nyron." while "How can I help you today?" is still being synthesised. Spoken whole,
    // a voice's first greeting (nothing cached yet) was 5.5 s of silence after pick-up.
    const pieces = new SentenceChunker();
    for (const piece of [...pieces.push(greeting.text), ...pieces.flush()]) {
      await this.speak(turn, piece, { language: greeting.language, cache: true });
    }
    this.log(this.resume ? "resume.spoken" : "greeting.spoken", { ms: turn.firstAudioSynthMs, language: greeting.language });
    this.currentTurn = null;
    this.settleState();

    // Have the holding lines ready before they are needed: synthesised once per voice for
    // the gateway's lifetime (tts.js cache), so a slow turn's "one moment" plays at once.
    for (const variant of [0, 1, 2]) {
      void this.tts
        .synthesize({ text: voiceLine("filler", greeting.language, variant), voiceId: this.voices[greeting.language], cache: true })
        .catch(() => {});
    }
    return true;
  }

  /**
   * What a call that has come back from an unanswered transfer says instead of a greeting: nobody is
   * available and the details can be taken for a call-back (the same fixed line as the other transports).
   * The conversation's handoff state is cleared first — it still said "passed on" — so the agent
   * carries on as itself (and can pass the caller on again, up to the webhook's limit).
   *
   * @returns {Promise<{text: string, language: "en"|"ur"}>}
   */
  async resumeLine() {
    this.log("call.resumed", { conversationId: this.resume.conversationId, previousCallId: this.resume.callId ?? null, resumes: this.resume.count ?? 1 });
    try {
      await this.brain.handoffFailed?.({ tenantId: this.tenantId, conversationId: this.recorder.conversationId });
    } catch (err) {
      console.error("[voice] could not reset the handoff state on resume:", err);
    }
    const language = this.resume.language === "ur" ? "ur" : this.resume.language === "en" ? "en" : this.config.replyLanguage === "ur" ? "ur" : "en";
    return { text: voiceLine("handoff_failed", language), language };
  }

  /**
   * End the call, once. Waits (bounded) for a turn still in flight so its record is
   * written before the call is summarised.
   *
   * @param {string} reason END_REASONS value
   */
  async end(reason, { insideTurn = false } = {}) {
    if (this.ended) return;
    this.ended = true;
    for (const timer of Object.values(this.timers)) this.clearTimer(timer);
    if (this.currentTurn) this.currentTurn.cancelled = true;
    this.holding?.deliver(null);
    this.vad?.reset();

    this.setState(CALL_STATES.ENDED);
    this.log("call.ended", { reason, turns: this.turnIndex, interruptions: this.interruptions });
    this.transport.notify(SERVER.ENDED, { reason });
    this.transport.close(reason);

    // Called from INSIDE the running turn (a transfer), waiting for "the turn in flight" would be
    // waiting for ourselves: the turn is already done with everything the record needs.
    let guard;
    if (!insideTurn) {
      await Promise.race([
        this.turnQueue(async () => {}),
        new Promise((resolve) => {
          guard = setTimeout(resolve, 10_000);
        }),
      ]);
      clearTimeout(guard);
    }
    await this.recorder?.close({
      status: reason === END_REASONS.ERROR ? "failed" : "completed",
      reason,
      turnCount: this.turnIndex,
      interruptions: this.interruptions,
      responseTimes: this.responseTimes,
      recordingUrl: this.keepRecording(),
    });
  }

  /**
   * Is THIS call's audio kept? Only a phone call (the console's browser calls are never recorded) whose agent
   * has the recording switch on — the switch the built-in greeting's "this call is recorded" reads, so what
   * callers are told and what happens are one setting (§6.24) — and only when storage is wired in.
   */
  shouldRecordAudio() {
    return Boolean(this.saveRecording && this.transportName === "twilio" && this.config?.recordCalls === true);
  }

  /** Stop recording and hand the audio to storage. @returns {Promise<string|null>} the reference for the call row */
  keepRecording() {
    const audio = this.audio;
    this.audio = null;
    if (!audio) return Promise.resolve(null);
    const wav = audio.toWav();
    if (!wav) return Promise.resolve(null);
    this.log("recording.finished", { seconds: Math.round(audio.seconds()), bytes: wav.length });
    return Promise.resolve(this.saveRecording({ tenantId: this.tenantId, callId: this.recorder.callId, wav })).catch((err) => {
      console.error("[voice] could not keep the recording:", err?.message ?? err);
      return null;
    });
  }

  /** The caller hung up. */
  hangup() {
    return this.end(END_REASONS.CALLER_HANGUP);
  }

  // ── inputs from the transport ────────────────────────────────────────────

  /**
   * Caller audio: 16 kHz mono float32.
   * @param {Float32Array} samples
   */
  onAudio(samples) {
    if (this.ended || !this.vad) return;
    this.audio?.caller(samples);
    let events;
    try {
      events = this.vad.push(samples);
    } catch (err) {
      console.error("[voice] VAD failed:", err);
      return;
    }

    for (const event of events) {
      if (event.type === "start") {
        this.bargedThisSpeech = false;
        this.lastSpeechStartedAt = this.now();
        this.armIdleTimer();
        this.log("speech.started");
        // Someone is talking: a call that was winding down is not over, and a silence check-in is answered.
        this.clearTimer(this.timers.closing);
        this.silenceStage = 0;
        // The caller is carrying on after a pause: wait for the rest instead of giving up on it.
        if (this.holding) {
          const hold = this.holding;
          this.clearTimer(hold.timer);
          // Safety net: speech that never turns into an utterance must not hold the turn forever.
          hold.timer = this.setTimer(() => hold.deliver(null), (VAD.maxSpeechSeconds + 2) * 1000);
        }
        if (!this.agentBusy()) this.setState(CALL_STATES.HEARING);
      } else if (event.type === "ongoing") {
        if (!this.bargedThisSpeech && this.agentBusy() && event.speechMs >= BARGE_IN.minSpeechMs) {
          this.bargedThisSpeech = true;
          this.bargeIn(event.speechMs);
        }
      } else if (event.type === "utterance") {
        this.onUtterance(event.samples, event.durationMs);
      }
    }
  }

  /**
   * The transport's playback state: the agent is audible until the CLIENT says the audio
   * finished playing — not when the gateway finished sending it.
   * @param {boolean} playing
   */
  onPlayback(playing) {
    this.clientPlaying = Boolean(playing);
    if (!this.clientPlaying) this.settleState();
  }

  // ── turns ────────────────────────────────────────────────────────────────

  onUtterance(samples, durationMs) {
    const speechEndedAt = this.now();
    this.lastUtteranceAt = speechEndedAt;
    this.log("speech.ended", { durationMs });
    this.armIdleTimer();
    // The previous half of a sentence is waiting for more: this IS the rest of it.
    if (this.holding) return this.holding.deliver({ samples, durationMs, speechEndedAt });
    // The caller carried on soon after a pause and has not heard a word of the answer yet: the
    // turn in flight is withdrawn and both halves are answered as ONE message (answerUtterance).
    // Once the agent has spoken it is an ordinary interruption instead (bargeIn).
    const inflight = this.inflight;
    if (
      inflight &&
      !inflight.superseded &&
      !inflight.audioSent &&
      this.lastSpeechStartedAt != null &&
      this.lastSpeechStartedAt - inflight.speechEndedAt <= CONTINUATION.lateMergeWithinMs
    ) {
      inflight.superseded = true;
      inflight.controller.abort();
      if (inflight.turn) {
        inflight.turn.cancelled = true;
        // If the brain finishes anyway, its reply is removed from the history (nothing was heard).
        inflight.turn.interrupted = true;
      }
      this.log("turn.withdrawn", { turn: inflight.turn?.index ?? null, afterMs: Math.round(this.lastSpeechStartedAt - inflight.speechEndedAt) });
    }
    // Turns run strictly one after another: the brain persists each user/assistant pair
    // in order, and a reply must never be spoken over the next question's reply.
    this.turnQueue(() => this.runTurn({ samples, durationMs, speechEndedAt }));
  }

  async runTurn(utterance) {
    const inflight = { controller: new AbortController(), superseded: false, audioSent: false, speechEndedAt: utterance.speechEndedAt, turn: null };
    this.inflight = inflight;
    try {
      await this.answerUtterance(utterance, inflight);
    } finally {
      if (this.inflight === inflight) this.inflight = null;
    }
  }

  /** What a turn withdrawn before it was heard had understood; taken once. */
  takeCarryOver() {
    const carry = this.carryOver;
    this.carryOver = null;
    return carry;
  }

  async answerUtterance({ samples, durationMs, speechEndedAt }, inflight) {
    if (this.ended) return;
    this.setState(CALL_STATES.THINKING);
    // The first half of this sentence, from a turn the caller carried on past (onUtterance).
    const carry = this.takeCarryOver();

    let transcript;
    try {
      transcript = await this.transcriber.transcribe(samples);
    } catch (err) {
      console.error("[voice] STT failed:", err);
      this.log("stt.failed", { message: String(err?.message ?? err).slice(0, 200) });
      if (!carry) {
        this.settleState();
        this.armClosing();
        return;
      }
      transcript = { text: "", ms: 0 };
    }
    if (!this.isSpeech(transcript.text)) {
      if (!carry) {
        this.log("stt.empty", { ms: transcript.ms, durationMs });
        // A short blip is noise (a cough, a click): not a turn, nothing answered — and a call that
        // was ending carries on ending. But a caller who really spoke and was not understood must
        // not be met with silence.
        if (durationMs >= UNHEARD.minSpeechMs && !this.ended) await this.onUnheard(durationMs);
        else {
          this.settleState();
          this.armClosing();
        }
        return;
      }
      // The rest was noise: the first half is still a question waiting for its answer.
      transcript = { ...transcript, text: "" };
    }
    if (carry) {
      this.log("utterance.merged", { first: carry.text.slice(0, 80), second: transcript.text.slice(0, 80), late: true });
      transcript = { ...carry.transcript, text: `${carry.text} ${transcript.text}`.trim(), ms: carry.transcript.ms + transcript.ms };
      durationMs += carry.durationMs;
    }
    this.unheardRun = 0;
    // The caller said something real: whatever was ending is not over.
    this.closing = null;
    if (this.ended) return;

    // A sentence the caller left unfinished ("…with", "…اور") is held for a moment: if the
    // rest follows it is ONE message, not two turns each answered on its own.
    let merged = 0;
    while (merged < CONTINUATION.maxMerges && looksUnfinished(transcript.text)) {
      const more = await this.awaitContinuation();
      if (!more) break;
      let extra;
      try {
        extra = await this.transcriber.transcribe(more.samples);
      } catch (err) {
        console.error("[voice] STT failed on a continuation:", err);
        break;
      }
      if (!this.isSpeech(extra.text)) break;
      this.log("utterance.merged", { first: transcript.text.slice(0, 80), second: extra.text.slice(0, 80) });
      transcript = { ...transcript, text: `${transcript.text.trim()} ${extra.text.trim()}`, ms: transcript.ms + extra.ms };
      durationMs += more.durationMs;
      speechEndedAt = more.speechEndedAt;
      merged++;
    }
    if (this.ended) return;

    // One utterance sometimes comes back with the same phrase written twice.
    const cleaned = collapseRepeats(transcript.text);
    if (cleaned.collapsed) this.log("stt.deduped", { before: transcript.text.slice(0, 120), after: cleaned.text.slice(0, 120) });
    const text = cleaned.text;

    // Withdrawn while it was being transcribed: hand what it heard to the next turn.
    if (inflight.superseded) {
      this.carryOver = { text, transcript, durationMs, index: carry?.index ?? null };
      return;
    }

    // Something said about the CALL, not the business: "hold on, let me find my card", or "yes, I'm
    // here" right after "are you still there?". Answered with a fixed line and never sent to the
    // brain — so it never enters the conversation, and the next real question follows straight on
    // from the exchange before the pause (the model's memory of it is not interrupted).
    const pause = carry ? null : detectPause(text, { kinds: this.checkInAsked ? ["holdOn", "stillHere"] : ["holdOn"] });
    if (pause) {
      await this.onPause(pause, { text, transcript, durationMs, speechEndedAt });
      return;
    }
    this.checkInAsked = false;
    this.patience = "normal";

    // A merged sentence keeps the turn number its first half was shown under, so the live
    // transcript REPLACES that half instead of showing it twice.
    const index = carry?.index ?? ++this.turnIndex;
    const turn = this.newTurn(index);
    inflight.turn = turn;
    turn.speechEndedAt = speechEndedAt;
    this.currentTurn = turn;
    this.log("stt.completed", {
      turn: index,
      ms: transcript.ms,
      chars: text.length,
      engine: transcript.engine,
      // The hosted recogniser failed and the local one answered instead (speech/stt.js) —
      // logged, because an Urdu caller transcribed by an English model is the likely cause
      // of whatever went wrong next.
      fallback: transcript.fallbackReason,
      // Names the recogniser misheard and vocabulary.js put right ("Nairan→Nyron").
      corrected: transcript.corrections,
    });
    this.transport.notify(SERVER.TRANSCRIPT, { turn: index, text, sttMs: transcript.ms, ...(carry?.index != null ? { replaces: true } : {}) });

    const filler = this.scheduleFiller(turn);
    const chunker = new SentenceChunker();
    const say = (sentence) => {
      turn.sentences.push(sentence);
      turn.speaking = turn.speaking.then(() => this.speak(turn, sentence));
    };

    let result = null;
    let error = null;
    try {
      result = await this.brain.respond({
        tenantId: this.tenantId,
        agentId: this.agentId,
        conversationId: this.recorder.conversationId,
        channel: "voice",
        userMessage: text,
        signal: inflight.controller.signal,
        onChunk: (delta) => chunker.push(delta).forEach(say),
        onStage: (stage, data) => {
          if (stage === "retrieved") {
            // Taking a customer's details is not a lookup: a "let me check that for you" in the
            // middle of it sounds wrong, and the next sentence is a fixed question anyway.
            if (data.collectionState && data.collectionState !== "idle") turn.collecting = true;
            this.log("retrieval.completed", {
              turn: index,
              ms: data.ms,
              skipped: data.skipped || undefined,
              sources: data.sources,
              searchQuery: data.searchQuery !== text ? data.searchQuery : null,
              rewrite: data.rewriteStatus,
              rewriteMs: data.rewriteMs,
            });
          } else if (stage === "first_token") {
            this.log("llm.first_token", { turn: index, ms: data.ms });
          }
        },
      });
      chunker.flush().forEach(say);
    } catch (err) {
      // Withdrawn (the caller carried on — onUtterance): the brain has put back everything the turn
      // wrote, and the next turn answers this text together with what the caller added. Nothing was
      // heard, nothing is recorded.
      if (err?.name === "TurnSupersededError") {
        this.clearTimer(filler);
        turn.cancelled = true;
        this.carryOver = { text, transcript, durationMs, index };
        if (this.currentTurn === turn) this.currentTurn = null;
        return;
      }
      error = String(err?.message ?? err).slice(0, 500);
      console.error(`[voice] turn ${index} failed:`, err);
      this.log("turn.failed", { turn: index, message: error.slice(0, 200) });
      this.transport.notify(SERVER.ERROR, { code: ERROR_CODES.TURN_FAILED, message: error.slice(0, 200) });
      // Whatever was already said stays said; the caller then hears a short, true
      // apology instead of silence (prompt.js voiceLine).
      say(voiceLine("fallback", this.lastLanguage ?? "en"));
    }

    await turn.speaking;
    this.clearTimer(filler);

    // The brain stored the WHOLE reply. If the caller cut it off, only the part that was
    // actually sent to them is what they heard: keep that, so the next turn does not build on
    // words nobody heard (the model would think the caller already knows them).
    if (turn.interrupted && !error) {
      await this.brain
        .trimLastReply?.({ tenantId: this.tenantId, conversationId: this.recorder.conversationId, spokenText: turn.spoken.join(" ") })
        ?.catch((err) => console.error("[voice] could not trim the stored reply:", err));
    }

    const classification = classifyTurn({
      callerText: text,
      sources: result?.sources ?? [],
      trigger: result?.searchTrigger ?? null,
      rewriteStatus: result?.rewriteStatus ?? null,
      failed: Boolean(error),
      requestState: result?.collection?.state ?? null,
    });
    const responseMs = turn.firstAudioAt != null ? Math.round(turn.firstAudioAt - speechEndedAt) : null;
    if (responseMs != null) this.responseTimes.push(responseMs);

    const timings = {
      speechMs: durationMs,
      sttMs: transcript.ms,
      contextMs: result?.timings?.contextMs ?? null,
      retrievalMs: result?.timings?.retrievalMs ?? null,
      rewriteMs: result?.timings?.rewriteMs ?? null,
      llmFirstTokenMs: result?.timings?.firstTokenMs ?? null,
      llmMs: result?.timings?.generationMs ?? null,
      ttsFirstAudioMs: turn.firstAudioSynthMs,
      responseMs,
      // Silences heard between pieces of the reply: how many, and the longest (§6.24).
      gapCount: turn.gaps.length,
      maxGapMs: turn.gaps.length ? Math.max(...turn.gaps) : 0,
    };
    const summary = {
      index,
      callerText: text,
      agentText: result?.reply ?? turn.sentences.join(" "),
      spokenText: turn.interrupted ? turn.spoken.join(" ") : null,
      interrupted: turn.interrupted,
      language: turn.language,
      ...classification,
      sources: result?.sources ?? [],
      searchQuery: result?.searchQuery ?? null,
      rewriteStatus: result?.rewriteStatus ?? null,
      model: result?.model ?? null,
      responseMs,
      timings,
      error,
    };

    this.recorder.turn(summary);
    this.log("turn.completed", {
      turn: index,
      intent: classification.intent,
      outcome: classification.outcome,
      responseMs,
      interrupted: turn.interrupted,
    });
    this.transport.notify(SERVER.TURN, {
      turn: index,
      intent: classification.intent,
      outcome: classification.outcome,
      topic: classification.topic,
      sources: summary.sources,
      searchQuery: summary.searchQuery,
      model: summary.model,
      interrupted: turn.interrupted,
      timings,
      failed: classification.outcome === OUTCOMES.FAILED,
    });

    if (this.currentTurn === turn) this.currentTurn = null;
    this.settleState();

    // What the caller heard the agent say: the next turn reads "did it ask anything else?" from it.
    const previousReply = this.lastAgentReply;
    if (!error) this.lastAgentReply = turn.interrupted ? turn.spoken.join(" ") : (result?.reply ?? turn.sentences.join(" "));

    // The reply said the caller is being connected to a person: now do it.
    if (result?.handoff?.kind === "handoff" && !error) {
      await this.performHandoff(result.handoff, { turn: index });
      return;
    }
    // Has the conversation come to its end? Rules, and the owner's switch (lib/voice/closing.js).
    const ending = decideCallEnd({
      settings: this.config,
      callerText: text,
      intent: classification.intent,
      previousReply,
      reply: this.lastAgentReply ?? "",
      requestOpen: this.requestOpen(result),
      onHold: this.patience === "hold",
      handoff: Boolean(result?.handoff),
      failed: Boolean(error),
      interrupted: turn.interrupted,
    });
    if (ending.end) await this.closeConversation(ending, { turn: index });
  }

  /**
   * The caller asked the agent to wait ("hold on", "ek minute") or answered the silence check-in
   * ("yes, I'm here"). A fixed line, logged as its own turn, and nothing for the brain: the
   * conversation history stays exactly as it was before the pause. After "hold on" the silence
   * check-in waits longer (SILENCE.hold) — someone fetching a card or a diary is not gone.
   *
   * @param {"holdOn"|"stillHere"} kind
   */
  async onPause(kind, { text, transcript, durationMs, speechEndedAt }) {
    const index = ++this.turnIndex;
    const language = this.lastLanguage ?? (this.config.replyLanguage === "ur" ? "ur" : "en");
    const line = voiceLine(kind === "holdOn" ? "take_your_time" : "listening", language, index);
    this.checkInAsked = false;
    if (kind === "holdOn") this.patience = "hold";
    this.log(kind === "holdOn" ? "caller.hold" : "silence.answered", { turn: index });
    this.transport.notify(SERVER.TRANSCRIPT, { turn: index, text, sttMs: transcript.ms });
    await this.speakFixed(line, language);
    const responseMs = Math.round(this.now() - speechEndedAt);
    const intent = kind === "holdOn" ? INTENTS.HOLD : INTENTS.PRESENCE;
    this.recorder.turn({
      index,
      callerText: text,
      agentText: line,
      language,
      intent,
      outcome: OUTCOMES.CONVERSATIONAL,
      sources: [],
      responseMs,
      timings: { speechMs: durationMs, sttMs: transcript.ms, responseMs },
    });
    this.transport.notify(SERVER.TURN, { turn: index, intent, outcome: OUTCOMES.CONVERSATIONAL, topic: null, sources: [], timings: { responseMs }, interrupted: false, failed: false });
    this.settleState();
  }

  /** @returns {boolean} the turn left a request half-taken: the caller is not finished */
  requestOpen(result) {
    const state = result?.collection?.state;
    return state === "ask" || state === "change";
  }

  /**
   * The conversation is over (lib/voice/closing.js): say goodbye if the reply did not, then end the
   * call once the last words have PLAYED and the owner's delay of quiet has passed.
   * @param {{trigger: string, sayClosingLine: boolean, delayMs: number}} ending
   */
  async closeConversation(ending, { turn }) {
    this.closing = ending;
    this.log("call.closing", { turn, trigger: ending.trigger, closingLine: ending.sayClosingLine, delayMs: ending.delayMs });
    if (ending.sayClosingLine) {
      const language = this.lastLanguage ?? (this.config.replyLanguage === "ur" ? "ur" : "en");
      await this.speakFixed(voiceLine("closing", language), language);
    }
    this.armClosing();
  }

  /**
   * (Re)start the countdown of a call that is ending. Speech from the caller stops it (onAudio);
   * a cough or click that turns out to be nothing starts it again; anything real cancels it.
   * Never ends while the agent's audio is still playing or the caller is talking.
   */
  armClosing() {
    const ending = this.closing;
    this.clearTimer(this.timers.closing);
    if (!ending || this.ended || this.callerTalking()) return;
    const untilQuiet = Math.max(0, (this.audioPlaysUntil ?? 0) - this.now()) + PLAYBACK_SLACK_MS;
    this.timers.closing = this.setTimer(() => {
      if (this.ended || this.closing !== ending || this.currentTurn || this.inflight || this.callerTalking()) return;
      // The client reported the audio still playing (the gateway's estimate was early): wait for it.
      if (this.agentBusy()) return this.armClosing();
      this.log("call.ended_by_itself", { trigger: ending.trigger });
      this.end(END_REASONS.AGENT_GOODBYE);
    }, untilQuiet + ending.delayMs);
  }

  /** @returns {boolean} the caller started speaking and that speech has not ended yet */
  callerTalking() {
    return this.lastSpeechStartedAt != null && (this.lastUtteranceAt == null || this.lastSpeechStartedAt > this.lastUtteranceAt);
  }

  /**
   * The caller spoke and nothing could be made of it. First time: ask them to say it again.
   * Again in a row: if the business has set up a person to hand to, pass the call on; otherwise
   * keep asking (politely) — the silence check-in ends a call nobody is really on.
   */
  async onUnheard(durationMs) {
    this.unheardRun++;
    // The caller tried to say something: the call is not over.
    this.closing = null;
    this.log("speech.unheard", { durationMs, inARow: this.unheardRun });
    let decision = null;
    try {
      decision = (await this.brain.noteUnheard?.({ tenantId: this.tenantId, agentId: this.agentId, conversationId: this.recorder.conversationId })) ?? null;
    } catch (err) {
      console.error("[voice] could not weigh unheard speech:", err);
    }
    const language = this.lastLanguage ?? "en";
    if (decision?.kind === "handoff") {
      // "Sorry, I couldn't understand." then the fixed line naming who they are passed to.
      const line = [voiceLine("connecting", language, this.unheardRun), decision.announcement].filter(Boolean).join(" ");
      await this.speakFixed(line, language);
      await this.performHandoff(decision, { turn: this.turnIndex });
      return;
    }
    await this.speakFixed(voiceLine("unheard", language, this.unheardRun), language);
    this.settleState();
  }

  /**
   * Pass the call to a person. Waits for the announcement to finish playing, then asks the
   * transport to place the transfer — contact by contact, in the owner's order, until someone
   * picks up. The transport is the only part that knows HOW (a phone line dials and bridges; the
   * browser test console only simulates it): `transport.transfer(contact, { summary, reason })`
   * resolves `{ connected: boolean, reason?: string }`. Nobody answering is not an error: the
   * agent says so and the call carries on, so the caller is never left on a dead line.
   *
   * @param {{contacts: object[], summary?: string, reason?: string}} handoff
   * @param {{turn: number}} context
   */
  async performHandoff(handoff, { turn }) {
    if (this.ended) return;
    await this.untilAudioEnds();
    if (this.ended) return;
    const contacts = handoff.contacts ?? [];
    this.log("handoff.started", { turn, reason: handoff.reason, contacts: contacts.map((c) => ({ id: c.id, role: c.role, name: c.name })) });

    let failure = "unsupported";
    if (typeof this.transport.transferInOrder === "function") {
      // A phone line hands the WHOLE ordered list to the network (Twilio rings the next person itself
      // when one does not answer), so the call cannot come back to the agent between attempts.
      this.log("handoff.attempt", { turn, contactIds: contacts.map((c) => c.id) });
      let outcome;
      try {
        outcome = await this.transport.transferInOrder(contacts, { summary: handoff.summary ?? "", reason: handoff.reason ?? null, callId: this.recorder?.callId ?? null, resume: this.resumeContext() });
      } catch (err) {
        console.error("[voice] transfer failed:", err);
        outcome = { connected: false, reason: "failed" };
      }
      if (this.ended) return;
      if (outcome?.connected) {
        this.log("handoff.completed", { turn, contactId: contacts[0]?.id ?? null, ordered: true });
        await this.end(END_REASONS.TRANSFERRED, { insideTurn: true });
        return;
      }
      failure = outcome?.reason ?? "failed";
      this.log("handoff.failed", { turn, reason: failure });
    } else if (typeof this.transport.transfer === "function") {
      for (const [index, contact] of contacts.entries()) {
        // The caller was told who they were being put through to (the reply ended with it). When that
        // person does not answer, they are told so and who is tried next — never silence on the line.
        if (index > 0) {
          const language = this.lastLanguage ?? (this.config.replyLanguage === "ur" ? "ur" : "en");
          await this.speakFixed(nextContactLine({ escalation: this.config.escalation, previous: contacts[index - 1], contact, language }), language);
          await this.untilAudioEnds();
          if (this.ended) return;
        }
        this.log("handoff.attempt", { turn, contactId: contact.id });
        let outcome;
        try {
          outcome = await this.transport.transfer(contact, { summary: handoff.summary ?? "", reason: handoff.reason ?? null, callId: this.recorder?.callId ?? null });
        } catch (err) {
          console.error("[voice] transfer failed:", err);
          outcome = { connected: false, reason: "failed" };
        }
        if (this.ended) return;
        if (outcome?.connected) {
          this.log("handoff.completed", { turn, contactId: contact.id, simulated: Boolean(outcome.simulated) });
          await this.end(END_REASONS.TRANSFERRED, { insideTurn: true });
          return;
        }
        failure = outcome?.reason ?? "no_answer";
        this.log("handoff.failed", { turn, contactId: contact.id, reason: failure });
      }
    }

    // Nobody could take the call: say so, and let the conversation go on (a call-back can be taken).
    this.log("handoff.unavailable", { turn, reason: failure });
    try {
      await this.brain.handoffFailed?.({ tenantId: this.tenantId, conversationId: this.recorder.conversationId });
    } catch (err) {
      console.error("[voice] could not record the failed handoff:", err);
    }
    const language = this.lastLanguage ?? "en";
    await this.speakFixed(voiceLine("handoff_failed", language), language);
    this.settleState();
  }

  /**
   * Where this call comes back to if a transfer nobody answers sends it home (twilio-webhook.js): the
   * conversation to carry on and what a resumed call needs to sound the same. Plain values — it travels
   * in a signed token.
   */
  resumeContext() {
    return {
      tenantId: this.tenantId,
      agentId: this.agentId,
      line: this.line,
      conversationId: this.recorder.conversationId,
      callId: this.recorder.callId,
      language: this.lastLanguage ?? (this.config.replyLanguage === "ur" ? "ur" : "en"),
      count: this.resume?.count ?? 0,
    };
  }

  /** Speak one of the fixed lines (prompt.js voiceLine) outside any turn: no model, cached audio. */
  async speakFixed(line, language) {
    if (this.ended) return;
    try {
      const audio = await this.tts.synthesize({ text: line, voiceId: this.voices[language], language, cache: true });
      if (this.ended) return;
      this.lastLanguage = language;
      this.sendAudio(audio);
      this.transport.notify(SERVER.AGENT_TEXT, { turn: this.turnIndex, text: line, system: true });
      this.setState(CALL_STATES.SPEAKING);
    } catch (err) {
      console.error("[voice] TTS failed on a fixed line:", err);
    }
  }

  /** Resolves once the audio sent so far has finished playing (by the gateway's own estimate). */
  untilAudioEnds() {
    const wait = Math.max(0, (this.audioPlaysUntil ?? 0) - this.now()) + PLAYBACK_SLACK_MS;
    return new Promise((resolve) => this.setTimer(resolve, wait));
  }

  /** Is this transcript a real utterance (letters, long enough) and not noise? */
  isSpeech(text) {
    return /\p{L}/u.test(text) && text.length >= LIMITS.minTranscriptChars;
  }

  /**
   * Wait a moment for the caller to carry on a sentence they left unfinished.
   * @returns {Promise<{samples: Float32Array, durationMs: number, speechEndedAt: number}|null>}
   *   the next utterance, or null when nothing came (the held half is then answered as it is)
   */
  awaitContinuation() {
    return new Promise((resolve) => {
      const finish = (value) => {
        this.clearTimer(hold.timer);
        if (this.holding === hold) this.holding = null;
        resolve(value);
      };
      const hold = {
        deliver: (utterance) => finish(utterance),
        timer: this.setTimer(() => finish(null), CONTINUATION.holdMs),
      };
      this.holding = hold;
    });
  }

  newTurn(index) {
    return {
      index,
      sentences: [],
      spoken: [],
      speaking: Promise.resolve(),
      cancelled: false,
      interrupted: false,
      language: null,
      speechEndedAt: null,
      firstAudioAt: null,
      firstAudioSynthMs: null,
      // Silences the caller heard between pieces of this reply (ms), see speak().
      gaps: [],
    };
  }

  /**
   * Keep a running measure of how fast speech is being made on this call. Past TTS.slowRatio the
   * pieces of a reply cannot all be ready in time, whatever the chunking (sentences.js says what
   * was tried): logged once per call (`tts.slow`), so the call's timeline says WHY it had gaps.
   * Cached lines say nothing about the machine's speed and are ignored.
   */
  noteSynthesisSpeed(audio) {
    if (audio.cached || !audio.speechMs || audio.ms == null) return;
    const ratio = audio.ms / audio.speechMs;
    this.ttsRatio = this.ttsRatio == null ? ratio : 0.6 * this.ttsRatio + 0.4 * ratio;
    if (!this.reportedSlow && this.ttsRatio > TTS.slowRatio) {
      this.reportedSlow = true;
      this.log("tts.slow", { ratio: Math.round(this.ttsRatio * 100) / 100 });
    }
  }

  /**
   * Synthesise one sentence and send it. Sentences of a turn are chained (turn.speaking),
   * so the next one is synthesised while this one plays on the client.
   */
  async speak(turn, sentence, { language, cache = false } = {}) {
    if (turn.cancelled || this.ended) return;
    const lang = language ?? chooseSpokenLanguage({
      replyLanguage: this.config.replyLanguage,
      text: sentence,
      previous: turn.language ?? this.lastLanguage,
    });

    // The pause after this piece is the one its JOIN needs: none between two pieces of one
    // sentence, a short one at a comma, a breath after a sentence (TTS in config.js).
    const ending = chunkEnding(sentence);
    const pauseMs = ending === "joined" ? TTS.joinPauseMs : ending === "comma" ? TTS.commaPauseMs : TTS.sentencePauseMs;

    let audio;
    try {
      audio = await this.tts.synthesize({ text: sentence, voiceId: this.voices[lang], language: lang, cache, pauseMs });
    } catch (err) {
      console.error("[voice] TTS failed:", err);
      this.log("tts.failed", { turn: turn.index, message: String(err?.message ?? err).slice(0, 200) });
      return;
    }
    // Interrupted while this sentence was being synthesised: it is never sent.
    if (turn.cancelled || this.ended) return;
    this.noteSynthesisSpeed(audio);

    // A GAP the caller hears: the previous piece of this reply finished playing before this one
    // was ready. Logged with where it fell — inside a sentence is the one that sounds like the
    // agent has finished talking.
    if (turn.spoken.length > 0 && this.audioPlaysUntil != null) {
      const gapMs = Math.round(this.now() - this.audioPlaysUntil);
      if (gapMs >= TTS.gapLogMs) {
        const after = chunkEnding(turn.spoken[turn.spoken.length - 1]);
        turn.gaps.push(gapMs);
        this.log("tts.gap", { turn: turn.index, ms: gapMs, piece: turn.spoken.length + 1, inSentence: after !== "sentence" });
      }
    }

    if (turn.firstAudioAt == null) {
      turn.firstAudioAt = this.now();
      turn.firstAudioSynthMs = audio.ms;
      if (turn.index > 0) {
        this.log("tts.first_audio", {
          turn: turn.index,
          synthMs: audio.ms,
          responseMs: Math.round(turn.firstAudioAt - turn.speechEndedAt),
        });
      }
    }
    turn.language ??= lang;
    this.lastLanguage = lang;
    if (this.inflight?.turn === turn) this.inflight.audioSent = true;
    turn.spoken.push(sentence);
    this.sendAudio(audio);
    if (turn.index > 0) this.transport.notify(SERVER.AGENT_TEXT, { turn: turn.index, text: sentence });
    this.setState(CALL_STATES.SPEAKING);
  }

  /** A short holding line if the reply is slow to start (FILLER) — a different phrasing
   *  each turn, so a slow provider does not make the agent repeat itself. */
  scheduleFiller(turn) {
    if (FILLER.afterMs == null) return null;
    return this.setTimer(() => {
      if (turn.firstAudioAt != null || turn.cancelled || this.ended) return;
      // The answer has already started — its first chunk is being synthesised and will be
      // heard in about a second. A "one moment" now just delays it and makes a simple
      // question sound hard (measured on two live calls: the filler fired 0.9 s before the
      // answer, every time). The filler is for a model that has produced NOTHING yet.
      if (turn.sentences.length > 0 || turn.collecting) return;
      const language = this.lastLanguage ?? "en";
      this.log("filler.spoken", { turn: turn.index });
      const line = voiceLine("filler", language, turn.index);
      // Spoken outside the reply's own chain: it must not wait for the first sentence.
      this.tts
        .synthesize({ text: line, voiceId: this.voices[language], language, cache: true })
        .then((audio) => {
          if (turn.firstAudioAt != null || turn.cancelled || this.ended) return;
          this.sendAudio(audio);
          // Shown in the live transcript because the caller heard it; never part of the
          // turn's agentText, which is the reply itself.
          this.transport.notify(SERVER.AGENT_TEXT, { turn: turn.index, text: line, filler: true });
        })
        .catch(() => {});
    }, FILLER.afterMs);
  }

  /** The caller talked over the agent: stop speaking, drop the rest of the reply. */
  bargeIn(speechMs) {
    const turn = this.currentTurn;
    if (turn) {
      turn.cancelled = true;
      turn.interrupted = true;
    }
    this.interruptions++;
    this.clientPlaying = false;
    this.audioPlaysUntil = null;
    this.audio?.cut();
    this.transport.clear();
    this.log("playback.interrupted", { turn: turn?.index ?? null, afterSpeechMs: speechMs, spokenSentences: turn?.spoken.length ?? 0 });
    this.setState(CALL_STATES.HEARING);
  }

  /**
   * Is the agent thinking or audible right now? Audible = the client is playing, or audio
   * was sent in the last moment and the client has not yet reported it playing.
   */
  agentBusy() {
    return Boolean(this.currentTurn && !this.currentTurn.cancelled) || this.agentAudible();
  }

  /**
   * Audio is playing. Two signals, either is enough: the client says so, or the gateway's
   * own clock says the audio it has sent cannot have finished yet. The second one does not
   * depend on the transport reporting playback at all (a phone line reports it
   * differently, §9.2) and covers the round trip before the client's report arrives.
   */
  agentAudible() {
    return this.clientPlaying || (this.audioPlaysUntil != null && this.now() < this.audioPlaysUntil + PLAYBACK_SLACK_MS);
  }

  /** Send audio and extend the estimate of when playback ends. */
  sendAudio(audio) {
    const durationMs = (audio.samples.length / audio.sampleRate) * 1000;
    const startsAt = Math.max(this.now(), this.audioPlaysUntil ?? 0);
    this.audioPlaysUntil = startsAt + durationMs;
    this.audio?.agent(audio.samples, audio.sampleRate);
    this.transport.audio(audio.samples, audio.sampleRate);

    this.clearTimer(this.timers.settle);
    this.timers.settle = this.setTimer(
      () => this.settleState(),
      Math.max(0, this.audioPlaysUntil - this.now()) + PLAYBACK_SLACK_MS + 10
    );
  }

  // ── state, timers, logging ───────────────────────────────────────────────

  /** Back to LISTENING once nothing is in flight and nothing is playing. If audio is
   *  still playing, the client's playback-ended report (onPlayback) settles it later. */
  settleState() {
    if (this.ended) return;
    if (this.currentTurn && !this.currentTurn.cancelled) return;
    if (this.agentAudible()) return;
    this.setState(CALL_STATES.LISTENING);
    // The caller's silence is measured from the moment the agent stopped talking — not from when
    // the caller last spoke, which would put a "still there?" right after a long answer. (While a
    // check-in is out, onSilence() runs its own timer.)
    if (this.silenceStage === 0) this.armIdleTimer();
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.transport.notify(SERVER.STATE, { state });
  }

  /**
   * The caller's silence clock — restarted by anything the caller does. It never runs while the
   * agent is thinking or speaking, asks "are you still there?" first (SILENCE in config.js),
   * and only then says goodbye and ends the call.
   */
  armIdleTimer() {
    if (this.ended) return;
    this.clearTimer(this.timers.idle);
    this.silenceStage = 0;
    const wait = this.patience === "hold" ? SILENCE.hold.checkInAfterMs : SILENCE.checkInAfterMs;
    this.timers.idle = this.setTimer(() => this.onSilence(), wait);
  }

  async onSilence() {
    if (this.ended) return;
    // Never act on someone mid-reply: the silence clock is about the CALLER.
    if (this.agentBusy()) return this.armIdleTimer();
    const language = this.lastLanguage ?? "en";

    if (this.silenceStage === 0) {
      this.silenceStage = 1;
      this.checkInAsked = true;
      this.log("silence.check_in");
      await this.speakFixed(voiceLine("still_there", language), language);
      if (this.ended) return;
      // The window to answer starts when the question has been heard.
      const answerWithin = this.patience === "hold" ? SILENCE.hold.endAfterCheckInMs : SILENCE.endAfterCheckInMs;
      const window = Math.max(0, (this.audioPlaysUntil ?? 0) - this.now()) + answerWithin;
      this.timers.idle = this.setTimer(() => this.onSilence(), window);
      return;
    }

    this.log("silence.ending");
    await this.speakFixed(voiceLine("silence_goodbye", language), language);
    await this.untilAudioEnds();
    this.end(END_REASONS.IDLE);
  }

  /** Write a timeline event and mirror it live to the transport. */
  log(type, data) {
    if (!this.recorder) return;
    const event = this.recorder.event(type, data);
    // Nested, never spread: the event has its own `type` ("speech.ended"…), which would
    // overwrite the message type if the two were merged into one object on the wire.
    this.transport.notify(SERVER.EVENT, { event });
  }

  /** For the gateway's health endpoint and logs. */
  describe() {
    return {
      tenantId: this.tenantId,
      agentId: this.agentId,
      callId: this.recorder?.callId ?? null,
      state: this.state,
      turns: this.turnIndex,
      medianResponseMs: median(this.responseTimes),
    };
  }
}
