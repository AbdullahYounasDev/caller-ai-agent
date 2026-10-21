import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "@/lib/voice/session";
import { CALL_STATES, END_REASONS, ERROR_CODES, SERVER } from "@/lib/voice/protocol";
import { BARGE_IN } from "@/lib/voice/config";

/**
 * The whole call flow with every dependency faked: no models, no database, no network,
 * no real timers. The fakes record what the session did, so each test reads as
 * "caller does X → the call does Y".
 */

function harness({ replies = [], transcripts = [], config = {} } = {}) {
  let now = 0;
  const timers = [];
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer = { fn, at: now + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
  };

  const sent = { audio: [], notify: [], clears: 0, closed: null };
  const transport = {
    audio: (samples, sampleRate) => sent.audio.push({ samples, sampleRate }),
    clear: () => sent.clears++,
    notify: (type, payload) => sent.notify.push({ type, ...payload }),
    close: (reason) => (sent.closed = reason),
  };

  // TTS: one second of audio per sentence; remembers what it was asked to say, and with
  // which voice.
  const spoken = [];
  const prepared = [];
  const tts = {
    prepare: async (ids) => prepared.push(...ids),
    synthesize: async ({ text, language, voiceId, cache }) => {
      // Fixed lines (greeting, fillers) are synthesised with cache: true; a reply never is.
      spoken.push(cache ? { text, language, voiceId, cache } : { text, language, voiceId });
      return { samples: new Float32Array(22050), sampleRate: 22050, ms: 7, voiceId };
    },
  };

  // STT seam: records which call it was asked to pick a recogniser for.
  const sttCalls = [];
  const stt = {
    forCall: (call) => {
      sttCalls.push(call);
      return { id: "fake-stt", understandsUrdu: true, transcribe: async () => ({ text: transcripts.shift() ?? "", ms: 11, engine: "fake-stt" }) };
    },
  };

  // VAD: the test decides what the detector "heard" via vad.next.
  const vad = { next: [], push() { const events = this.next; this.next = []; return events; }, reset() {} };

  const recorded = { turns: [], events: [], greeting: null, closed: null };
  const recorder = {
    callId: "call-1",
    conversationId: "conv-1",
    seq: 0,
    event(type, data) {
      const e = { seq: ++this.seq, type, atMs: now, data };
      recorded.events.push(e);
      return e;
    },
    agentLine: (text) => (recorded.greeting = text),
    turn: (t) => recorded.turns.push(t),
    close: async (summary) => {
      recorded.closed = summary;
    },
  };

  const calls = [];
  const trims = [];
  const brain = {
    trimLastReply: async (args) => trims.push(args),
    invalidateAgentConfig: () => {},
    getAgentConfig: async () => ({ businessName: "Nyron", replyLanguage: "en", ...config }),
    respond: async (args) => {
      calls.push(args);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply(args);
    },
  };

  const session = new CallSession({
    tenantId: "t1",
    transportName: "browser",
    transport,
    stt,
    tts,
    createVad: () => vad,
    engineInfo: { stt: "fake" },
    brain,
    openRecorder: async () => recorder,
    clock,
  });

  return {
    session,
    sent,
    spoken,
    prepared,
    sttCalls,
    recorded,
    calls,
    trims,
    vad,
    advance: (ms) => (now += ms),
    /** Move the clock on and run every timer that has come due (and was not cleared). */
    tick: (ms) => {
      now += ms;
      for (const timer of timers.filter((t) => !t.cleared && t.at <= now)) {
        timer.cleared = true;
        timer.fn();
      }
    },
    /** Feed the VAD's verdict for the next audio frame. */
    hear: (...events) => {
      vad.next = events;
      session.onAudio(new Float32Array(512));
    },
    /** Wait until every queued turn has finished. */
    settle: () => session.turnQueue(async () => {}),
    notified: (type) => sent.notify.filter((n) => n.type === type),
  };
}

/** A fake respond() that streams `text` in small pieces and returns a full result. */
const streams = (text, extra = {}) => async ({ onChunk, onStage }) => {
  onStage?.("retrieved", { sources: extra.sources ?? [], searchQuery: null, rewriteStatus: null, ms: 40 });
  for (let i = 0; i < text.length; i += 4) onChunk(text.slice(i, i + 4));
  return {
    reply: text,
    sources: extra.sources ?? [],
    searchTrigger: null,
    rewriteStatus: null,
    searchQuery: null,
    model: "gemini:test",
    timings: { contextMs: 3, retrievalMs: 40, rewriteMs: null, firstTokenMs: 300, generationMs: 500 },
  };
};

const utterance = { type: "utterance", samples: new Float32Array(16000), durationMs: 1000 };

describe("CallSession", () => {
  test("answering: the agent introduces itself first, and the greeting is in the transcript", async () => {
    const h = harness();
    assert.equal(await h.session.start(), true);

    assert.equal(h.notified(SERVER.READY)[0].callId, "call-1");
    assert.equal(h.recorded.greeting, "Hello, thanks for calling Nyron. How can I help you today?");
    // Spoken sentence by sentence, so the first is heard while the second is synthesised.
    assert.deepEqual(h.spoken.slice(0, 2), [
      { text: "Hello, thanks for calling Nyron.", language: "en", voiceId: "kokoro:af_heart", cache: true },
      { text: "How can I help you today?", language: "en", voiceId: "kokoro:af_heart", cache: true },
    ]);
    // The holding lines are synthesised ahead (cached), but only the greeting is PLAYED.
    assert.deepEqual(h.spoken.slice(2).map((s) => s.cache), [true, true, true]);
    assert.equal(h.sent.audio.length, 2);
    // The greeting's voice is loaded before it is spoken.
    assert.equal(h.prepared[0], "kokoro:af_heart");
    // The recogniser is taught the business's name.
    assert.deepEqual(h.sttCalls[0].vocabulary, ["Nyron"]);
    assert.ok(h.recorded.events.some((e) => e.type === "call.started"));
    // Audio was just sent and is still "playing" by the gateway's own estimate.
    assert.equal(h.session.state, CALL_STATES.SPEAKING);
  });

  test("a turn: transcript → the brain → reply spoken sentence by sentence → logged with intent and timings", async () => {
    const h = harness({
      transcripts: ["How much is the Pro plan?"],
      replies: [streams("The Pro plan is 149 euro a month. Anything else?", { sources: ["03-pricing.docx"] })],
    });
    await h.session.start();
    h.advance(5000); // the greeting has finished playing

    h.hear({ type: "start" }, utterance);
    h.advance(1);
    await h.settle();

    // The brain was called exactly as the chat calls it, but on the voice channel.
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].channel, "voice");
    assert.equal(h.calls[0].userMessage, "How much is the Pro plan?");
    assert.equal(h.calls[0].conversationId, "conv-1");

    // Two sentences, synthesised and sent in order, after the greeting.
    assert.deepEqual(h.spoken.filter((s) => !s.cache).map((s) => s.text), ["The Pro plan is 149 euro a month.", "Anything else?"]);
    assert.equal(h.sent.audio.length, 4); // the greeting's two sentences + the reply's two
    assert.deepEqual(h.notified(SERVER.AGENT_TEXT).slice(1).map((n) => n.text), ["The Pro plan is 149 euro a month.", "Anything else?"]);

    const [turn] = h.recorded.turns;
    assert.equal(turn.index, 1);
    assert.equal(turn.intent, "question");
    assert.equal(turn.outcome, "answered");
    assert.equal(turn.topic, "pricing");
    assert.equal(turn.interrupted, false);
    assert.equal(turn.timings.sttMs, 11);
    assert.equal(turn.timings.llmFirstTokenMs, 300);
    assert.equal(turn.timings.ttsFirstAudioMs, 7);
    assert.equal(typeof turn.responseMs, "number");
    assert.equal(h.notified(SERVER.TURN)[0].outcome, "answered");
    for (const type of ["speech.started", "speech.ended", "stt.completed", "retrieval.completed", "tts.first_audio", "turn.completed"]) {
      assert.ok(h.recorded.events.some((e) => e.type === type), `missing event ${type}`);
    }
  });

  test("barge-in: the caller talks over the reply → playback cleared, the rest is never spoken, turn logged as interrupted", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = harness({
      transcripts: ["What are your hours?"],
      replies: [
        async ({ onChunk }) => {
          onChunk("We open at nine every weekday. ");
          await gate; // the caller interrupts while the rest is still being generated
          onChunk("We close at six. On Saturdays we close at one.");
          return { reply: "We open at nine every weekday. We close at six. On Saturdays we close at one.", sources: ["hours.md"], timings: {} };
        },
      ],
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.spoken.at(-1).text, "We open at nine every weekday.");

    // A short backchannel ("mm-hm") is NOT a barge-in…
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs - 100 });
    assert.equal(h.sent.clears, 0);
    // …sustained speech is.
    h.hear({ type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 10 });
    assert.equal(h.sent.clears, 1);
    assert.ok(h.recorded.events.some((e) => e.type === "playback.interrupted"));

    release();
    await h.settle();
    assert.ok(!h.spoken.some((s) => s.text.startsWith("We close")), "nothing after the interruption is synthesised");
    const [turn] = h.recorded.turns;
    assert.equal(turn.interrupted, true);
    assert.equal(turn.spokenText, "We open at nine every weekday.");
    assert.equal(turn.agentText, "We open at nine every weekday. We close at six. On Saturdays we close at one.");
    assert.equal(h.session.interruptions, 1);
  });

  test("noise the VAD let through is not a turn: no brain call, nothing recorded", async () => {
    const h = harness({ transcripts: ["", "."] });
    await h.session.start();
    h.hear(utterance);
    h.hear(utterance);
    await h.settle();
    assert.equal(h.calls.length, 0);
    assert.equal(h.recorded.turns.length, 0);
    assert.equal(h.recorded.events.filter((e) => e.type === "stt.empty").length, 2);
  });

  test("a failed turn: the caller hears a short apology, the call goes on, the turn is logged as failed", async () => {
    const h = harness({
      transcripts: ["How much is Pro?", "And Lite?"],
      replies: [new Error("429 RESOURCE_EXHAUSTED"), streams("Lite is 59 euro.")],
    });
    await h.session.start();
    h.hear(utterance);
    await h.settle();

    assert.match(h.spoken.at(-1).text, /^Sorry, I'm having trouble/);
    assert.equal(h.recorded.turns[0].outcome, "failed");
    assert.match(h.recorded.turns[0].error, /RESOURCE_EXHAUSTED/);
    assert.equal(h.notified(SERVER.ERROR)[0].code, ERROR_CODES.TURN_FAILED);
    assert.equal(h.sent.closed, null, "the call is still up");

    h.hear(utterance);
    await h.settle();
    assert.equal(h.recorded.turns[1].outcome, "no_knowledge");
    assert.equal(h.spoken.at(-1).text, "Lite is 59 euro.");
  });

  test("turns are answered strictly in order, even when the caller speaks twice quickly", async () => {
    const h = harness({
      transcripts: ["First question?", "Second question?"],
      replies: [streams("First answer."), streams("Second answer.")],
    });
    await h.session.start();
    h.hear(utterance);
    h.hear(utterance);
    await h.settle();
    assert.deepEqual(h.calls.map((c) => c.userMessage), ["First question?", "Second question?"]);
    assert.deepEqual(h.recorded.turns.map((t) => t.index), [1, 2]);
  });

  test("ending: written once, with the reason and the call's counts; the connection is closed", async () => {
    const h = harness({ transcripts: ["Hi there, what do you do?"], replies: [streams("We build software.")] });
    await h.session.start();
    h.hear(utterance);
    await h.settle();

    await h.session.hangup();
    await h.session.end(END_REASONS.DISCONNECTED); // second end is a no-op

    assert.equal(h.sent.closed, END_REASONS.CALLER_HANGUP);
    assert.deepEqual(
      { status: h.recorded.closed.status, reason: h.recorded.closed.reason, turnCount: h.recorded.closed.turnCount },
      { status: "completed", reason: END_REASONS.CALLER_HANGUP, turnCount: 1 }
    );
    assert.equal(h.recorded.closed.responseTimes.length, 1);
    assert.equal(h.notified(SERVER.ENDED).length, 1);

    // After the end, audio is ignored.
    h.hear(utterance);
    await h.settle();
    assert.equal(h.calls.length, 1);
  });

  test("the business's voice is used for its reply language, and the recogniser never depends on that language", async () => {
    const h = harness({
      config: { replyLanguage: "ur", voices: { ur: "kokoro:hm_omega", en: "piper:en_US-ryan-medium" } },
      transcripts: ["آپ کے اوقات کیا ہیں؟"],
      replies: [streams("ہم پیر سے جمعہ کھلے ہیں۔")],
    });
    await h.session.start();
    // The recogniser is asked for with the business's vocabulary ONLY: every call must
    // understand Urdu and English whichever language it answers in.
    assert.deepEqual(h.sttCalls, [{ vocabulary: ["Nyron"] }]);
    // Urdu greeting, male voice → masculine verb.
    assert.match(`${h.spoken[0].text} ${h.spoken[1].text}`, /^السلام علیکم، Nyron کو کال کرنے کا شکریہ۔ .*سکتا ہوں؟$/);
    assert.equal(h.spoken[0].voiceId, "kokoro:hm_omega");

    h.hear(utterance);
    await h.settle();
    assert.deepEqual(h.spoken.at(-1), { text: "ہم پیر سے جمعہ کھلے ہیں۔", language: "ur", voiceId: "kokoro:hm_omega" });
    assert.equal(h.recorded.turns[0].language, "ur");
  });

  test("a recogniser that cannot understand Urdu says so in the timeline of EVERY call, whichever language it answers in", async () => {
    const cannot = { forCall: () => ({ id: "parakeet", understandsUrdu: false, transcribe: async () => ({ text: "", ms: 1 }) }) };
    for (const replyLanguage of ["en", "ur"]) {
      const h = harness({ config: { replyLanguage } });
      h.session.stt = cannot;
      await h.session.start();
      assert.deepEqual(h.recorded.events.find((e) => e.type === "stt.urdu_unavailable")?.data, { stt: "parakeet" }, replyLanguage);
    }
    const fine = harness({ config: { replyLanguage: "en" } });
    await fine.session.start();
    assert.ok(!fine.recorded.events.some((e) => e.type === "stt.urdu_unavailable"), "a recogniser that hears Urdu is not warned about");
  });

  test("a voice id that is not a real voice for its language falls back to that language's default", async () => {
    const h = harness({ config: { replyLanguage: "ur", voices: { ur: "kokoro:af_heart" } } });
    await h.session.start();
    assert.equal(h.spoken[0].voiceId, "kokoro:hf_alpha");
  });

  test("a stored 'auto' or Italian reply language (older data) is spoken as English, never as an unknown language", async () => {
    for (const replyLanguage of ["auto", "it"]) {
      const h = harness({ config: { replyLanguage } });
      await h.session.start();
      assert.equal(h.spoken[0].language, "en", replyLanguage);
      assert.equal(h.spoken[0].voiceId, "kokoro:af_heart", replyLanguage);
    }
  });

  test("set-up failure (config or database down) refuses the call cleanly instead of throwing", async () => {
    const h = harness();
    h.session.brain.getAgentConfig = async () => {
      throw new Error("db down");
    };
    assert.equal(await h.session.start(), false);
    assert.equal(h.sent.closed, END_REASONS.SETUP_FAILED);
    assert.equal(h.notified(SERVER.ERROR)[0].code, ERROR_CODES.INTERNAL);
  });

  // ── turn quality: the five fixes ──────────────────────────────────────────

  test("a sentence the caller left unfinished is held, and the rest that follows is ONE message", async () => {
    const h = harness({
      transcripts: ["I want to book an appointment with", "Doctor Ayesha on Monday at ten."],
      replies: [streams("Of course. May I have your name?")],
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls.length, 0, "the first half is waiting, not being answered");

    h.advance(400); // a short pause, well inside the hold
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls.length, 1, "one brain call for both halves");
    assert.equal(h.calls[0].userMessage, "I want to book an appointment with Doctor Ayesha on Monday at ten.");
    assert.equal(h.recorded.turns.length, 1);
    assert.ok(h.recorded.events.some((e) => e.type === "utterance.merged"));
  });

  test("an unfinished sentence nobody continues is answered as it is, after the hold", async () => {
    const h = harness({ transcripts: ["I would like to know about the prices and"], replies: [streams("Our prices start at fifty.")] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls.length, 0);
    h.tick(1300);
    await h.settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].userMessage, "I would like to know about the prices and");
  });

  test("a complete sentence never waits", async () => {
    const h = harness({ transcripts: ["What are your opening hours?"], replies: [streams("Nine to six.")] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls.length, 1);
  });

  test("a phrase the recogniser wrote twice reaches the brain (and the log) once", async () => {
    const h = harness({ transcripts: ["Yes, book it now. Yes, book it now."], replies: [streams("Done.")] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls[0].userMessage, "Yes, book it now.");
    assert.equal(h.recorded.turns[0].callerText, "Yes, book it now.");
    assert.ok(h.recorded.events.some((e) => e.type === "stt.deduped"));
  });

  test("no 'one moment' filler on a turn that is only collecting a customer's details", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = harness({
      transcripts: ["zero three zero zero one two three four five six seven"],
      replies: [
        async ({ onChunk, onStage }) => {
          onStage("retrieved", { sources: [], searchQuery: null, rewriteStatus: null, ms: 0, skipped: true, collectionState: "ask" });
          await gate; // a slow model: nothing has been said yet
          onChunk("Thanks. And which day suits you?");
          return { reply: "Thanks. And which day suits you?", sources: [], collection: { state: "ask" }, timings: {} };
        },
      ],
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    h.tick(3000); // far past FILLER.afterMs
    await new Promise((r) => setImmediate(r));
    assert.ok(!h.recorded.events.some((e) => e.type === "filler.spoken"), "no filler while taking details");
    release();
    await h.settle();
    assert.equal(h.recorded.turns[0].outcome, "conversational", "a phone number is not an 'unanswered' question");
  });

  test("the filler still plays on an ordinary slow turn", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = harness({
      transcripts: ["Tell me about your refund policy please."],
      replies: [
        async ({ onChunk, onStage }) => {
          onStage("retrieved", { sources: ["refunds.md"], searchQuery: null, rewriteStatus: null, ms: 0, collectionState: null });
          await gate;
          onChunk("Refunds take five days.");
          return { reply: "Refunds take five days.", sources: ["refunds.md"], timings: {} };
        },
      ],
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    h.tick(3000);
    assert.ok(h.recorded.events.some((e) => e.type === "filler.spoken"));
    release();
    await h.settle();
  });

  test("after an interruption only the part that was spoken is kept as the agent's reply", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = harness({
      transcripts: ["What are your hours?"],
      replies: [
        async ({ onChunk }) => {
          onChunk("We open at nine every weekday. ");
          await gate;
          onChunk("We close at six.");
          return { reply: "We open at nine every weekday. We close at six.", sources: ["hours.md"], timings: {} };
        },
      ],
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 10 });
    release();
    await h.settle();
    assert.deepEqual(h.trims, [{ tenantId: "t1", conversationId: "conv-1", spokenText: "We open at nine every weekday." }]);
  });

  test("a reply nobody interrupted is stored whole", async () => {
    const h = harness({ transcripts: ["What are your hours?"], replies: [streams("Nine to six.")] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.deepEqual(h.trims, []);
  });
});
