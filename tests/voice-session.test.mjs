import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "@/lib/voice/session";
import { CALL_STATES, END_REASONS, ERROR_CODES, SERVER } from "@/lib/voice/protocol";
import { BARGE_IN, CLOSING, SILENCE } from "@/lib/voice/config";

/**
 * The whole call flow with every dependency faked: no models, no database, no network,
 * no real timers. The fakes record what the session did, so each test reads as
 * "caller does X → the call does Y".
 */

function harness({ replies = [], transcripts = [], config = {}, transfer, noteUnheard, agentId, line } = {}) {
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

  const sent = { audio: [], notify: [], clears: 0, closed: null, transfers: [] };
  const transport = {
    ...(transfer
      ? {
          transfer: async (contact, context) => {
            sent.transfers.push({ contact, context });
            return transfer(contact, context);
          },
        }
      : {}),
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
  const configReads = [];
  const recorderOpens = [];
  const trims = [];
  const handoffFailures = [];
  const brain = {
    noteUnheard: noteUnheard ?? (async () => null),
    handoffFailed: async (args) => handoffFailures.push(args),
    trimLastReply: async (args) => trims.push(args),
    invalidateAgentConfig: () => {},
    getAgentConfig: async (tenantId, options) => {
      configReads.push({ tenantId, ...options });
      return { businessName: "Nyron", replyLanguage: "en", ...config };
    },
    respond: async (args) => {
      calls.push(args);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply(args);
    },
  };

  const session = new CallSession({
    tenantId: "t1",
    agentId,
    line,
    transportName: "browser",
    transport,
    stt,
    tts,
    createVad: () => vad,
    engineInfo: { stt: "fake" },
    brain,
    openRecorder: async (args) => {
      recorderOpens.push(args);
      return recorder;
    },
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
    configReads,
    recorderOpens,
    trims,
    handoffFailures,
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
    /** Let the call run for `ms` of fake time, in small steps, letting promises settle between
     *  them — timers that a step creates are seen by the next one. */
    pump: async (ms, steps = 60) => {
      for (let i = 0; i < steps; i++) {
        await new Promise((r) => setImmediate(r));
        now += ms / steps;
        for (const timer of timers.filter((t) => !t.cleared && t.at <= now)) {
          timer.cleared = true;
          timer.fn();
        }
      }
      await new Promise((r) => setImmediate(r));
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
    assert.equal(h.recorded.greeting, "Hello, thanks for calling Nyron. You're speaking with an AI assistant. How can I help you today?");
    // Spoken sentence by sentence, so the first is heard while the next is synthesised.
    assert.deepEqual(h.spoken.slice(0, 3), [
      { text: "Hello, thanks for calling Nyron.", language: "en", voiceId: "kokoro:af_heart", cache: true },
      { text: "You're speaking with an AI assistant.", language: "en", voiceId: "kokoro:af_heart", cache: true },
      { text: "How can I help you today?", language: "en", voiceId: "kokoro:af_heart", cache: true },
    ]);
    // The holding lines are synthesised ahead (cached), but only the greeting is PLAYED.
    assert.deepEqual(h.spoken.slice(3).map((s) => s.cache), [true, true, true]);
    assert.equal(h.sent.audio.length, 3);
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
    assert.equal(h.sent.audio.length, 5); // the greeting's three sentences + the reply's two
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
    const blip = { type: "utterance", samples: new Float32Array(4000), durationMs: 300 };
    h.hear(blip);
    h.hear(blip);
    await h.settle();
    assert.equal(h.calls.length, 0);
    assert.equal(h.recorded.turns.length, 0);
    assert.equal(h.recorded.events.filter((e) => e.type === "stt.empty").length, 2);
    assert.ok(!h.recorded.events.some((e) => e.type === "speech.unheard"), "a blip is not a person we failed to hear");
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
    assert.match(`${h.spoken[0].text} ${h.spoken[1].text} ${h.spoken[2].text}`, /^السلام علیکم، Nyron کو کال کرنے کا شکریہ۔ آپ ایک اے آئی اسسٹنٹ سے بات کر رہے ہیں۔ .*سکتا ہوں؟$/);
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

  // ── several agents per tenant (CLAUDE.md §6.27) ─────────────────────────────

  test("a call is answered by the agent its ticket named: settings, call record and every turn", async () => {
    const h = harness({
      agentId: "agent-dublin",
      config: { agentId: "agent-dublin", status: "active", businessName: "Pizza Dublin" },
      transcripts: ["Are you open on Sunday?"],
      replies: [streams("Yes, from noon.")],
    });
    assert.equal(await h.session.start(), true);
    assert.deepEqual(h.configReads[0], { tenantId: "t1", agentId: "agent-dublin" });
    assert.equal(h.recorderOpens[0].agentId, "agent-dublin");
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls[0].agentId, "agent-dublin");
  });

  test("a call for 'the default agent' keeps the default agent's id, even if the default changes later", async () => {
    const h = harness({ config: { agentId: "agent-main", status: "active" } });
    await h.session.start();
    assert.equal(h.configReads[0].agentId, null, "asked for the default");
    assert.equal(h.session.agentId, "agent-main", "then held on to the agent that answered");
    assert.equal(h.recorderOpens[0].agentId, "agent-main");
  });

  test("a call that came in on one of the business's numbers is recorded with that number (§6.29)", async () => {
    const h = harness({ agentId: "agent-dublin", line: { numberId: "n1", toNumber: "+35312345678" }, config: { agentId: "agent-dublin", status: "active" } });
    await h.session.start();
    assert.equal(h.recorderOpens[0].toNumber, "+35312345678");
    assert.equal(h.recorderOpens[0].phoneNumberId, "n1");
    assert.equal(h.recorded.events.find((e) => e.type === "call.started").data.toNumber, "+35312345678");
  });

  test("a plain console call records no number", async () => {
    const h = harness({ config: { agentId: "agent-main", status: "active" } });
    await h.session.start();
    assert.equal(h.recorderOpens[0].toNumber, null);
    assert.equal(h.recorderOpens[0].phoneNumberId, null);
  });

  test("an agent archived after its ticket was issued does not answer", async () => {
    const h = harness({ agentId: "agent-old", config: { agentId: "agent-old", status: "archived" } });
    assert.equal(await h.session.start(), false);
    assert.equal(h.sent.closed, END_REASONS.SETUP_FAILED);
    assert.equal(h.recorderOpens.length, 0, "no call record is opened");
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

  // ── passing the call to a person ──────────────────────────────────────────

  const CONTACTS = [
    { id: "c1", role: "Representative", name: "Bilal", phone: "+923001234567" },
    { id: "c2", role: "Senior doctor", name: "Dr Ayesha", phone: "+923215551234" },
  ];
  const handingOff = (extra = {}) => async ({ onChunk }) => {
    onChunk("Of course. I'm connecting you to our representative, Bilal.");
    return { reply: "Of course. I'm connecting you to our representative, Bilal.", sources: [], handoff: { kind: "handoff", reason: "asked", contacts: CONTACTS, summary: "The caller asked to speak to a person." }, ...extra };
  };

  test("the reply says who the caller is being connected to, THEN the transfer is placed, then the call ends as 'transferred'", async () => {
    const h = harness({ transcripts: ["I want to speak to a person."], replies: [handingOff()], transfer: async () => ({ connected: true, simulated: true }) });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(300);
    assert.equal(h.sent.transfers.length, 0, "not before the announcement has played");
    await h.pump(5000); // the announcement finishes playing
    await h.settle();
    assert.equal(h.sent.transfers.length, 1);
    assert.equal(h.sent.transfers[0].contact.id, "c1", "the owner's first contact is tried first");
    assert.equal(h.sent.transfers[0].context.summary, "The caller asked to speak to a person.");
    assert.equal(h.sent.transfers[0].context.reason, "asked");
    assert.equal(h.spoken.filter((x) => !x.cache).map((x) => x.text).join(" "), "Of course. I'm connecting you to our representative, Bilal.");
    assert.equal(h.sent.closed, END_REASONS.TRANSFERRED);
    for (const type of ["handoff.started", "handoff.attempt", "handoff.completed"]) assert.ok(h.recorded.events.some((e) => e.type === type), type);
    assert.equal(h.recorded.closed.reason, END_REASONS.TRANSFERRED);
  });

  test("nobody picks up the first contact: the next one is tried; the caller is never left on a dead line", async () => {
    const answers = { c1: { connected: false, reason: "no_answer" }, c2: { connected: true } };
    const h = harness({ transcripts: ["connect me to a person"], replies: [handingOff()], transfer: async (c) => answers[c.id] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(8000);
    await h.settle();
    assert.deepEqual(h.sent.transfers.map((t) => t.contact.id), ["c1", "c2"]);
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.failed" && e.data.contactId === "c1" && e.data.reason === "no_answer"));
    assert.equal(h.sent.closed, END_REASONS.TRANSFERRED);
  });

  test("nobody at all can take it: the agent says so, the call carries on, the conversation is not left 'passed on'", async () => {
    const h = harness({ transcripts: ["connect me to a person"], replies: [handingOff()], transfer: async () => ({ connected: false, reason: "busy" }) });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(8000);
    await h.settle();
    assert.equal(h.sent.transfers.length, 2);
    assert.equal(h.sent.closed, null, "the call is NOT ended");
    assert.deepEqual(h.handoffFailures, [{ tenantId: "t1", conversationId: "conv-1" }]);
    assert.ok(h.spoken.some((x) => x.text.startsWith("I'm sorry, nobody is available")), "the caller hears why");
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.unavailable"));
  });

  test("a transport that cannot transfer (no phone line) is the same as nobody answering", async () => {
    const h = harness({ transcripts: ["connect me to a person"], replies: [handingOff()] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(8000);
    await h.settle();
    assert.equal(h.sent.closed, null);
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.unavailable" && e.data.reason === "unsupported"));
    assert.ok(h.spoken.some((x) => x.text.startsWith("I'm sorry, nobody is available")));
  });

  test("a transfer that throws is a failed attempt, never a crashed call", async () => {
    const h = harness({ transcripts: ["connect me to a person"], replies: [handingOff()], transfer: async () => { throw new Error("carrier down"); } });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(8000);
    await h.settle();
    assert.equal(h.sent.closed, null);
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.failed" && e.data.reason === "failed"));
  });

  test("a reply that does NOT carry a handoff never places a transfer", async () => {
    const h = harness({ transcripts: ["What are your hours?"], replies: [streams("Nine to six.")], transfer: async () => ({ connected: true }) });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.sent.transfers.length, 0);
  });

  test("speech that could not be read: first time 'say it again', a person asked for on the second", async () => {
    const decisions = [{ kind: "rephrase" }, { kind: "handoff", reason: "not_understood", contacts: CONTACTS, summary: "The assistant could not understand or answer the caller." }];
    const h = harness({ transcripts: ["", ""], noteUnheard: async () => decisions.shift(), transfer: async () => ({ connected: true }) });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.ok(h.spoken.some((x) => x.text === "Sorry, I didn't catch that. Could you say it again, please?" || x.text === "I'm sorry, the line wasn't clear. Could you repeat that for me?"));
    assert.equal(h.sent.closed, null);
    assert.equal(h.recorded.events.filter((e) => e.type === "speech.unheard").length, 1);

    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(8000);
    await h.settle();
    assert.ok(h.spoken.some((x) => x.text.startsWith("I'm sorry I couldn't understand. Let me connect you")));
    assert.equal(h.sent.transfers[0].context.reason, "not_understood");
    assert.equal(h.sent.closed, END_REASONS.TRANSFERRED);
  });

  test("with no one to hand to, unheard speech is still met with a polite 'say it again' — never silence", async () => {
    const h = harness({ transcripts: [""], noteUnheard: async () => null });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.ok(h.spoken.some((x) => /didn't catch that|wasn't clear/.test(x.text)));
  });

  test("unheard speech in Urdu is answered in Urdu, with no Latin names and no gendered forms", async () => {
    const h = harness({ config: { replyLanguage: "ur" }, transcripts: [""], noteUnheard: async () => null });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    const line = h.spoken.filter((x) => x.language === "ur").at(-1);
    assert.match(line.text, /[\u0600-\u06FF]/);
    assert.doesNotMatch(line.text, /[A-Za-z]/);
  });

  // ── silence on the line ──────────────────────────────────────────────────

  test("quiet for 15 s: the agent asks 'are you still there?' — it does not hang up", async () => {
    const h = harness();
    await h.session.start();
    await h.pump(SILENCE.checkInAfterMs + 8000);
    assert.ok(h.recorded.events.some((e) => e.type === "silence.check_in"));
    assert.ok(h.spoken.some((x) => x.text === "Are you still there?" || x.text === "Hello, are you still with me?"));
    assert.equal(h.sent.closed, null);
  });

  test("the silence is measured from when the AGENT stopped talking, not from when the call began", async () => {
    const h = harness();
    await h.session.start();
    // The greeting plays for about 2 s: the check-in comes 15 s after it ends, not 15 s after pick-up.
    await h.pump(SILENCE.checkInAfterMs - 1000);
    assert.ok(!h.recorded.events.some((e) => e.type === "silence.check_in"));
    await h.pump(5000);
    assert.ok(h.recorded.events.some((e) => e.type === "silence.check_in"));
  });

  test("still quiet after the check-in: a polite goodbye is spoken, then the call ends as idle_timeout", async () => {
    const h = harness();
    await h.session.start();
    await h.pump(SILENCE.checkInAfterMs + 5000);
    assert.equal(h.sent.closed, null, "not yet: the caller has the whole second window to answer");
    await h.pump(SILENCE.endAfterCheckInMs + 8000);
    assert.ok(h.spoken.some((x) => x.text.startsWith("I can't hear you, so I'll end the call now")));
    assert.ok(h.recorded.events.some((e) => e.type === "silence.ending"));
    assert.equal(h.sent.closed, END_REASONS.IDLE);
  });

  test("the caller answering the check-in carries on: nothing ends", async () => {
    const h = harness({ transcripts: ["Yes, I'm here."], replies: [streams("Great, how can I help?")] });
    await h.session.start();
    await h.pump(SILENCE.checkInAfterMs + 4000);
    assert.ok(h.recorded.events.some((e) => e.type === "silence.check_in"));
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(SILENCE.endAfterCheckInMs + 2000);
    assert.equal(h.sent.closed, null);
    assert.ok(!h.recorded.events.some((e) => e.type === "silence.ending"));
  });

  test("the silence clock never runs while the agent is still talking", async () => {
    const h = harness({ transcripts: ["Tell me everything."], replies: [streams("A very long answer. ".repeat(30))] });
    await h.session.start();
    await h.pump(2500);
    h.hear({ type: "start" }, utterance);
    await h.pump(SILENCE.checkInAfterMs - 3000);
    // 12 s after the caller stopped the agent is mid-answer (30 sentences, a second each): no check-in.
    assert.ok(!h.recorded.events.some((e) => e.type === "silence.check_in"));
  });

  // ── ending a conversation that has reached its conclusion ─────────────────

  test("the caller says goodbye, the agent answers: after a short quiet the call ends by itself", async () => {
    const h = harness({ transcripts: ["No, that's all, thank you. Bye."], replies: [streams("You're welcome. Goodbye!")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.sent.closed, null, "not at once: the caller might add something");
    await h.pump(CLOSING.afterGoodbyeMs + 6000);
    assert.equal(h.sent.closed, END_REASONS.AGENT_GOODBYE);
    assert.ok(h.recorded.events.some((e) => e.type === "call.closing"));
  });

  test("…but anything the caller says in that quiet keeps the call open", async () => {
    const h = harness({ transcripts: ["That's all, thanks, bye.", "Oh wait, one more thing."], replies: [streams("Goodbye!"), streams("Of course, go ahead.")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(1000);
    h.hear({ type: "start" }); // the caller starts to speak again
    await h.pump(CLOSING.afterGoodbyeMs + 6000);
    assert.equal(h.sent.closed, null);
    h.hear(utterance);
    await h.settle();
    assert.equal(h.calls.length, 2);
  });

  test("a long sentence that happens to contain 'that's all' is not a goodbye", async () => {
    const h = harness({ transcripts: ["Well that's all very interesting but I still need to know about the price of the implants"], replies: [streams("Implants start at fifty thousand.")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(CLOSING.afterGoodbyeMs + 6000);
    assert.equal(h.sent.closed, null);
  });

  test("a goodbye in the middle of taking a request does not end the call", async () => {
    const h = harness({ transcripts: ["bye"], replies: [async ({ onChunk }) => {
      onChunk("Before you go, may I have your phone number?");
      return { reply: "Before you go, may I have your phone number?", sources: [], collection: { state: "ask", field: "phone" } };
    }] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(CLOSING.afterGoodbyeMs + 6000);
    assert.equal(h.sent.closed, null);
  });
});
