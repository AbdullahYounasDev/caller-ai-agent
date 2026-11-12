import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "@/lib/voice/session";
import { CALL_STATES, END_REASONS, ERROR_CODES, SERVER } from "@/lib/voice/protocol";
import { BARGE_IN, SILENCE, TTS } from "@/lib/voice/config";
import { END_DELAY_SECONDS } from "@/lib/voice/closing";
import { EchoGuard } from "@/lib/voice/echo-guard";

const CLOSING_DELAY_MS = END_DELAY_SECONDS.default * 1000;

/**
 * The whole call flow with every dependency faked: no models, no database, no network,
 * no real timers. The fakes record what the session did, so each test reads as
 * "caller does X → the call does Y".
 */

function harness({ replies = [], transcripts = [], config = {}, transfer, transferInOrder, noteUnheard, agentId, line, resume, transportName = "browser", saveRecording, synthDelayMs = 0, synthMs = 7, speechMs, fastFirstChunk = false, installedVoices = null, synthMsFor = null, echoGuard = false } = {}) {
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

  const sent = { audio: [], notify: [], clears: 0, closed: null, transfers: [], ordered: [] };
  const transport = {
    ...(transferInOrder
      ? {
          transferInOrder: async (contacts, context) => {
            sent.ordered.push({ contacts, context });
            return transferInOrder(contacts, context);
          },
        }
      : {}),
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
  const synthArgs = [];
  const prepared = [];
  const tts = {
    prepare: async (ids) => prepared.push(...ids),
    // Which voices exist on this fake machine (null = all of them).
    isInstalled: (id) => (installedVoices ? installedVoices.includes(id) : true),
    synthesize: async (args) => {
      const { text, language, voiceId, cache } = args;
      // Fixed lines (greeting, fillers) are synthesised with cache: true; a reply never is.
      spoken.push(cache ? { text, language, voiceId, cache } : { text, language, voiceId });
      synthArgs.push(args);
      // A slow machine: the piece is ready only after `synthDelayMs` of (fake) time.
      if (synthDelayMs && !cache) await new Promise((resolve) => clock.setTimeout(resolve, synthDelayMs));
      return { samples: new Float32Array(22050), sampleRate: 22050, ms: synthMsFor ? synthMsFor(args) : synthMs, voiceId, ...(speechMs ? { speechMs } : {}) };
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
    resume,
    transportName,
    saveRecording,
    fastFirstChunk,
    echoGuard,
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
    synthArgs,
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
    // The caller is told the first person is not available and who is tried next — before the second transfer.
    assert.ok(h.spoken.some((x) => x.text === "Bilal isn't available right now. I'm connecting you to Dr Ayesha, our Senior doctor. Please stay on the line."));
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

  test("a phone line hands the WHOLE ordered list over once, after the announcement; the call then ends as 'transferred'", async () => {
    const h = harness({ transcripts: ["I want to speak to a person."], replies: [handingOff()], transferInOrder: async () => ({ connected: true }) });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(300);
    assert.equal(h.sent.ordered.length, 0, "not before the announcement has played");
    await h.pump(5000);
    await h.settle();
    assert.equal(h.sent.ordered.length, 1, "one hand-over, not one per person");
    assert.deepEqual(h.sent.ordered[0].contacts.map((c) => c.id), ["c1", "c2"]);
    assert.equal(h.sent.ordered[0].contacts[0].phone, "+923001234567", "the transport gets the numbers");
    assert.equal(h.sent.ordered[0].context.summary, "The caller asked to speak to a person.");
    assert.equal(h.sent.closed, END_REASONS.TRANSFERRED);
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.completed" && e.data.ordered === true));
  });

  test("the transfer is told where the call comes back to: this conversation, call, line and language", async () => {
    const h = harness({ transcripts: ["connect me to a person"], replies: [handingOff()], agentId: "agent-1", config: { agentId: "agent-1" }, line: { numberId: "n1", toNumber: "+442071234567", fromNumber: null }, transferInOrder: async () => ({ connected: true }) });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(8000);
    await h.settle();
    assert.deepEqual(h.sent.ordered[0].context.resume, {
      tenantId: "t1", agentId: "agent-1", line: { numberId: "n1", toNumber: "+442071234567", fromNumber: null },
      conversationId: "conv-1", callId: "call-1", language: "en", count: 0,
    });
  });

  describe("recording the call's audio (§6.30)", () => {
    const saved = [];
    const keeper = (result = "file:t1/call-1.wav") => async (args) => (saved.push(args), result);
    const phone = (extra = {}) => harness({ transportName: "twilio", config: { recordCalls: true }, saveRecording: keeper(), ...extra });

    test("a phone call whose agent has recording on is kept: both sides, one file, its reference on the call", async () => {
      saved.length = 0;
      const h = phone();
      await h.session.start();
      h.session.onAudio(new Float32Array(1600).fill(0.3));
      h.advance(500);
      await h.session.hangup();
      assert.equal(saved.length, 1);
      assert.deepEqual([saved[0].tenantId, saved[0].callId], ["t1", "call-1"]);
      assert.equal(saved[0].wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(saved[0].wav.readUInt16LE(22), 2, "stereo: caller and agent apart");
      assert.equal(await h.recorded.closed.recordingUrl, "file:t1/call-1.wav");
      const types = h.recorded.events.map((e) => e.type);
      assert.ok(types.includes("recording.started") && types.includes("recording.finished"));
    });

    test("recording off, or a browser call, or no storage: nothing is kept and nothing is logged", async () => {
      for (const make of [
        () => phone({ config: { recordCalls: false } }),
        () => phone({ transportName: "browser" }),
        () => phone({ saveRecording: undefined }),
      ]) {
        saved.length = 0;
        const h = make();
        await h.session.start();
        h.session.onAudio(new Float32Array(1600).fill(0.3));
        await h.session.hangup();
        assert.equal(saved.length, 0);
        assert.equal(await h.recorded.closed.recordingUrl, null);
        assert.ok(!h.recorded.events.some((e) => e.type.startsWith("recording.")));
      }
    });

    test("a storage that fails never breaks the hang-up — the call is simply left without a recording", async () => {
      const h = phone({ saveRecording: async () => { throw new Error("disk full"); } });
      await h.session.start();
      h.session.onAudio(new Float32Array(1600).fill(0.3));
      await h.session.hangup();
      assert.equal(await h.recorded.closed.recordingUrl, null);
      assert.equal(h.recorded.closed.status, "completed");
    });

    test("a barge-in cuts the recorded agent audio to what was heard", async () => {
      const h = phone();
      await h.session.start();
      const before = h.session.audio.agentEnd;
      assert.ok(before > 0, "the greeting is in the recording");
      h.session.bargeIn(400);
      assert.ok(h.session.audio.agentEnd <= before);
    });
  });

  describe("a call that comes back from a transfer nobody answered", () => {
    const resume = { conversationId: "conv-1", callId: "call-0", language: "en", count: 1 };

    test("continues the SAME conversation, does not greet again, says nobody is available and clears the handoff state", async () => {
      const h = harness({ resume, agentId: "agent-1" });
      assert.equal(await h.session.start(), true);
      await h.settle();
      assert.equal(h.recorderOpens[0].conversationId, "conv-1");
      assert.ok(h.spoken.some((x) => x.text.startsWith("I'm sorry, nobody is available")), "the caller hears why they are back");
      assert.ok(!h.spoken.some((x) => /thanks for calling/i.test(x.text)), "no second greeting");
      assert.ok(h.recorded.greeting.startsWith("I'm sorry, nobody is available"), "the line is in the transcript the model reads next");
      assert.equal(h.handoffFailures.length, 1);
      const resumed = h.recorded.events.find((e) => e.type === "call.resumed");
      assert.deepEqual(resumed.data, { conversationId: "conv-1", previousCallId: "call-0", resumes: 1 });
      assert.ok(h.recorded.events.some((e) => e.type === "resume.spoken") && !h.recorded.events.some((e) => e.type === "greeting.spoken"));
      assert.equal(h.recorded.events.find((e) => e.type === "call.started").data.resumedFromCallId, "call-0");
    });

    test("speaks in the language the call was last in", async () => {
      const h = harness({ resume: { ...resume, language: "ur" } });
      await h.session.start();
      await h.settle();
      assert.ok(h.spoken.some((x) => x.language === "ur" && x.text.startsWith("معذرت، اس وقت کوئی دستیاب نہیں")));
    });

    test("an ordinary call does not open an old conversation", async () => {
      const h = harness();
      await h.session.start();
      assert.equal(h.recorderOpens[0].conversationId, null);
    });

    test("a second transfer from a resumed call counts the comebacks so far", async () => {
      const h = harness({ resume: { ...resume, count: 2 }, transcripts: ["connect me to a person"], replies: [handingOff()], transferInOrder: async () => ({ connected: true }) });
      await h.session.start();
      h.advance(5000);
      h.hear({ type: "start" }, utterance);
      await h.pump(8000);
      await h.settle();
      assert.equal(h.sent.ordered[0].context.resume.count, 2);
    });
  });

  test("a phone line that could not place the transfer leaves the call with the agent, which says nobody is available", async () => {
    const h = harness({ transcripts: ["connect me to a person"], replies: [handingOff()], transferInOrder: async () => ({ connected: false, reason: "failed" }) });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(8000);
    await h.settle();
    assert.equal(h.sent.closed, null);
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.failed" && e.data.reason === "failed"));
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.unavailable"));
    assert.ok(h.spoken.some((x) => x.text.startsWith("I'm sorry, nobody is available")));
    assert.equal(h.handoffFailures.length, 1, "the conversation's handoff state is reset");
  });

  test("a phone transfer that throws is a failed attempt, never a crashed call", async () => {
    const h = harness({ transcripts: ["connect me to a person"], replies: [handingOff()], transferInOrder: async () => { throw new Error("twilio down"); } });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(8000);
    await h.settle();
    assert.equal(h.sent.closed, null);
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.failed"));
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
    const decisions = [{ kind: "rephrase" }, { kind: "handoff", reason: "not_understood", contacts: CONTACTS, summary: "The assistant could not understand or answer the caller.", announcement: "I'm connecting you to Dr Ayesha, our Senior doctor. Please stay on the line." }];
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
    // An apology, then the fixed line that NAMES who the caller is passed to — before the transfer.
    assert.ok(h.spoken.some((x) => x.text === "I'm sorry, I couldn't understand. I'm connecting you to Dr Ayesha, our Senior doctor. Please stay on the line."));
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
    await h.pump(CLOSING_DELAY_MS + 6000);
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
    await h.pump(CLOSING_DELAY_MS + 6000);
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
    await h.pump(CLOSING_DELAY_MS + 6000);
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
    await h.pump(CLOSING_DELAY_MS + 6000);
    assert.equal(h.sent.closed, null);
  });

  test("'no thanks' after the agent asked 'anything else?' ends the call — with a goodbye added when the reply had none", async () => {
    const h = harness({
      transcripts: ["What time do you open?", "No thanks."],
      replies: [streams("We open at nine. Is there anything else I can help you with?"), streams("You're welcome.")],
    });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(CLOSING_DELAY_MS + 6000);
    assert.equal(h.sent.closed, null, "a question was asked: the call waits for the answer");
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.ok(h.spoken.some((s) => s.text === "Thank you for calling. Goodbye."), "the fixed goodbye follows a reply that said none");
    const closing = h.recorded.events.find((e) => e.type === "call.closing");
    assert.equal(closing.data.trigger, "no_more_questions");
    await h.pump(CLOSING_DELAY_MS + 6000);
    assert.equal(h.sent.closed, END_REASONS.AGENT_GOODBYE);
    assert.equal(h.recorded.events.find((e) => e.type === "call.ended_by_itself").data.trigger, "no_more_questions");
  });

  test("the agent's own goodbye ends the call, and no second goodbye is added", async () => {
    const h = harness({ transcripts: ["Okay great, thanks for the help."], replies: [streams("You're welcome! Have a great day.")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(CLOSING_DELAY_MS + 6000);
    assert.equal(h.sent.closed, END_REASONS.AGENT_GOODBYE);
    assert.equal(h.recorded.events.find((e) => e.type === "call.closing").data.trigger, "agent_farewell");
    assert.ok(!h.spoken.some((s) => s.text === "Thank you for calling. Goodbye."));
  });

  test("a plain 'no' that is not an answer to 'anything else?' does not end the call", async () => {
    const h = harness({
      transcripts: ["Do you do whitening?", "No."],
      replies: [streams("Yes, whitening is fifteen thousand. Would you like to book it?"), streams("No problem. Our cleaning is five thousand.")],
    });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(CLOSING_DELAY_MS + 6000);
    assert.equal(h.sent.closed, null);
  });

  test("a goodbye answered with a question keeps the call open", async () => {
    const h = harness({ transcripts: ["Bye."], replies: [streams("Before you go, would you like our opening hours?")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(CLOSING_DELAY_MS + 6000);
    assert.equal(h.sent.closed, null);
  });

  test("the owner's wait is respected: not before it, yes after it", async () => {
    const h = harness({ config: { endCallDelaySeconds: 8 }, transcripts: ["That's all, thanks. Bye."], replies: [streams("Goodbye!")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    // One second of reply audio, then 8 s of quiet.
    await h.pump(7000);
    assert.equal(h.sent.closed, null, "7 s after the goodbye: still open");
    await h.pump(4000);
    assert.equal(h.sent.closed, END_REASONS.AGENT_GOODBYE);
  });

  test("the owner switched it off: the call stays open for the caller to hang up", async () => {
    const h = harness({ config: { autoEndCalls: false }, transcripts: ["That's all, thanks. Bye."], replies: [streams("Goodbye!")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(CLOSING_DELAY_MS + 6000);
    assert.equal(h.sent.closed, null);
    assert.ok(!h.recorded.events.some((e) => e.type === "call.closing"));
  });

  test("a cough in the quiet does not keep a finished call open; real words do", async () => {
    const h = harness({ transcripts: ["That's all, thanks. Bye.", ""], replies: [streams("Goodbye!")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(1500);
    h.hear({ type: "start" });
    await h.pump(CLOSING_DELAY_MS + 3000);
    assert.equal(h.sent.closed, null, "while the caller is making a sound, the call never ends");
    h.hear({ type: "utterance", samples: new Float32Array(3200), durationMs: 200 }); // nothing in it
    await h.settle();
    await h.pump(CLOSING_DELAY_MS + 2000);
    assert.equal(h.sent.closed, END_REASONS.AGENT_GOODBYE);
  });

  test("the call-ending style is only on calls, and only while the switch is on", async () => {
    const { buildSystemInstruction } = await import("@/lib/agent/prompt");
    const config = { businessName: "Nyron", tone: "professional", replyLanguage: "en" };
    assert.match(buildSystemInstruction({ config, channel: "voice" }), /ENDING THE CALL: .*ask nothing more/);
    assert.doesNotMatch(buildSystemInstruction({ config: { ...config, autoEndCalls: false }, channel: "voice" }), /ENDING THE CALL/);
    assert.doesNotMatch(buildSystemInstruction({ config, channel: "chat" }), /ENDING THE CALL/);
  });

  // ── a sentence cut by a pause, and pauses in the call (CLAUDE.md §6.24) ────

  /** A respond() that has not answered yet — it ends only when the session withdraws the turn. */
  const waitsUntilWithdrawn = async ({ signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => {
        const err = new Error("withdrawn");
        err.name = "TurnSupersededError";
        reject(err);
      })
    );

  test("the caller carries on before hearing anything: both halves are answered as ONE message", async () => {
    const h = harness({
      transcripts: ["I want to book an appointment.", "for tomorrow at five."],
      replies: [waitsUntilWithdrawn, streams("Sure, tomorrow at five.")],
    });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.pump(800); // the first half is being answered — nothing heard yet
    h.hear({ type: "start" });
    h.advance(900);
    h.hear(utterance);
    await h.settle();
    await h.settle();

    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[0].signal.aborted, "the first answer was withdrawn");
    assert.equal(h.calls[1].userMessage, "I want to book an appointment. for tomorrow at five.");
    assert.equal(h.recorded.turns.length, 1, "one turn recorded, not two");
    assert.equal(h.recorded.turns[0].index, 1);
    assert.equal(h.recorded.turns[0].callerText, "I want to book an appointment. for tomorrow at five.");
    // The console REPLACES the half it showed under turn 1.
    const shown = h.notified(SERVER.TRANSCRIPT);
    assert.deepEqual(shown.map((n) => [n.turn, Boolean(n.replaces)]), [[1, false], [1, true]]);
    assert.ok(h.recorded.events.some((e) => e.type === "turn.withdrawn"));
    assert.ok(h.recorded.events.some((e) => e.type === "utterance.merged" && e.data.late));
    assert.ok(!h.spoken.some((x) => /trouble answering/.test(x.text)), "no apology: nothing failed");
  });

  test("speech that comes too long after the first half is its own question", async () => {
    const h = harness({
      transcripts: ["What are your hours?", "Hello?"],
      replies: [streams("We open at nine."), streams("Yes, I'm here.")],
    });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(4000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].userMessage, "Hello?");
    assert.equal(h.recorded.turns.length, 2);
  });

  test("once the agent has started speaking, carrying on is an interruption, not a merge", async () => {
    const h = harness({
      transcripts: ["I want to book an appointment.", "for tomorrow at five."],
      replies: [streams("Of course. What day suits you? We are open all week."), streams("Tomorrow at five works.")],
    });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.pump(200); // the first sentence of the answer has been sent
    h.hear({ type: "start" });
    h.advance(300);
    h.hear(utterance);
    await h.settle();
    await h.settle();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].userMessage, "for tomorrow at five.", "the second half is its own message");
    assert.ok(!h.recorded.events.some((e) => e.type === "turn.withdrawn"));
  });

  test("if the rest turns out to be noise, the first half is still answered", async () => {
    const h = harness({
      transcripts: ["I want to book an appointment.", ""],
      replies: [waitsUntilWithdrawn, streams("Of course.")],
    });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.pump(500);
    h.hear({ type: "start" });
    h.advance(600);
    h.hear(utterance);
    await h.settle();
    await h.settle();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].userMessage, "I want to book an appointment.");
    assert.equal(h.recorded.turns.length, 1);
  });

  test("'hold on, let me find my card': a fixed 'take your time', no brain call, and a much longer wait", async () => {
    const h = harness({ transcripts: ["Hold on, let me find my card."] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls.length, 0, "nothing for the brain: the conversation history is untouched");
    assert.ok(h.spoken.some((x) => /take your time/i.test(x.text)));
    assert.equal(h.recorded.turns[0].intent, "hold");
    assert.equal(h.recorded.turns[0].outcome, "conversational");
    // No "are you still there?" after the usual 15 s…
    await h.pump(SILENCE.checkInAfterMs + 10_000);
    assert.ok(!h.recorded.events.some((e) => e.type === "silence.check_in"));
    // …only after the longer hold window (60 s from the "take your time"; 25 s have passed).
    await h.pump(SILENCE.hold.checkInAfterMs - 20_000);
    assert.ok(h.recorded.events.some((e) => e.type === "silence.check_in"));
    assert.equal(h.sent.closed, null);
  });

  test("Urdu and Roman Urdu 'one minute' are a hold too, answered in the agent's language", async () => {
    for (const said of ["ایک منٹ رکیں", "aik minute ruko"]) {
      const h = harness({ transcripts: [said], config: { replyLanguage: "ur" } });
      await h.session.start();
      await h.pump(3000);
      h.hear({ type: "start" }, utterance);
      await h.settle();
      assert.equal(h.calls.length, 0, said);
      assert.equal(h.recorded.turns[0].intent, "hold", said);
      assert.ok(h.spoken.some((x) => x.language === "ur" && /آرام سے/.test(x.text)), said);
    }
  });

  test("after the hold, the next real question goes to the brain as usual and patience is back to normal", async () => {
    const h = harness({ transcripts: ["One moment please.", "OK, my card ends in 4421."], replies: [streams("Thank you.")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(20_000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].userMessage, "OK, my card ends in 4421.");
    await h.pump(SILENCE.checkInAfterMs + 5000);
    assert.ok(h.recorded.events.some((e) => e.type === "silence.check_in"), "the normal 15 s check-in again");
  });

  test("'yes, I'm here' answers the check-in — a fixed reply, nothing for the brain", async () => {
    const h = harness({ transcripts: ["Yes, I'm here."] });
    await h.session.start();
    await h.pump(SILENCE.checkInAfterMs + 4000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls.length, 0);
    assert.equal(h.recorded.turns[0].intent, "presence");
    assert.ok(h.spoken.some((x) => /go ahead/i.test(x.text)));
  });

  test("a plain 'yes' with no check-in is an answer to the conversation, and goes to the brain", async () => {
    const h = harness({ transcripts: ["Do you do root canals?", "Yes."], replies: [streams("We do. Shall I take your details?"), streams("Great.")] });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    await h.pump(4000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].userMessage, "Yes.");
  });

  // ── no long silences inside the agent's own sentences ─────────────────────

  test("each piece gets the pause its join needs: none inside a sentence, short at a comma, full after a sentence", async () => {
    const h = harness({
      transcripts: ["When are you open?"],
      replies: [streams("Our clinic is open from nine in the morning until six in the evening, Monday to Saturday. We are closed on Sundays.")],
    });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    const reply = h.synthArgs.filter((a) => !a.cache);
    const byEnding = reply.map((a) => [a.text.trim().slice(-1), a.pauseMs]);
    for (const [last, pauseMs] of byEnding) {
      if (/[.!?]/.test(last)) assert.equal(pauseMs, TTS.sentencePauseMs);
      else if (last === ",") assert.equal(pauseMs, TTS.commaPauseMs);
      else assert.equal(pauseMs, TTS.joinPauseMs, "no pause between two pieces of one sentence");
    }
    assert.ok(byEnding.some(([, p]) => p === TTS.joinPauseMs), "the long sentence was cut, and that join has no pause");
  });

  test("a piece that is not ready when the previous one ends is logged as a gap the caller heard", async () => {
    const h = harness({
      transcripts: ["When are you open?"],
      replies: [streams("Our clinic is open from nine in the morning until six in the evening, Monday to Saturday.")],
      synthDelayMs: 1500, // each piece takes 1.5 s to make and plays for 1 s
    });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.pump(12_000);
    await h.settle();
    const gaps = h.recorded.events.filter((e) => e.type === "tts.gap");
    assert.ok(gaps.length >= 1, "the gap is on the timeline");
    assert.ok(gaps.every((g) => g.data.ms >= TTS.gapLogMs && g.data.inSentence === true));
    const timings = h.recorded.turns[0].timings;
    assert.equal(timings.gapCount, gaps.length);
    assert.ok(timings.maxGapMs >= 400);
  });

  test("a call whose speech is made slower than it plays says so on its timeline, once", async () => {
    const h = harness({
      transcripts: ["When are you open?"],
      replies: [streams("Our clinic is open from nine in the morning until six in the evening, Monday to Saturday.")],
      synthMs: 1300, // 1.3 s to make…
      speechMs: 1000, // …1 s of speech: slower than real time
    });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.recorded.events.filter((e) => e.type === "tts.slow").length, 1);
  });

  test("a machine that keeps up is never reported slow", async () => {
    const h = harness({ transcripts: ["When are you open?"], replies: [streams("We open at nine in the morning and close at six in the evening every weekday.")], synthMs: 500, speechMs: 1000 });
    await h.session.start();
    await h.pump(3000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.ok(!h.recorded.events.some((e) => e.type === "tts.slow"));
  });
});

// THE FAST START (CLAUDE.md §6.24, voices.js): with it on, the first piece of an English reply is made by the Piper voice
// that matches the agent's, so the caller hears the answer start about a second sooner (measured: a 45-character first
// chunk takes Kokoro 1.5–2.2 s and Piper 0.3–0.55 s); everything after it is the owner's own voice. Off unless the gateway
// turns it on — nobody has listened to two engines in one reply yet.
describe("the fast start: the first piece of a reply in the fast voice", () => {
  const REPLY = "The Pro plan is 149 euro a month. Anything else?";
  const askOnce = async (h) => {
    await h.session.start();
    h.advance(5000); // the greeting has finished playing
    h.hear({ type: "start" }, utterance);
    h.advance(1);
    await h.settle();
  };
  /** What the reply's own pieces were spoken with (the greeting and the holding lines are cached). */
  const replyVoices = (h) => h.synthArgs.filter((a) => !a.cache);

  test("OFF (the default): every piece of the reply is the owner's voice, and nothing asks for a level change", async () => {
    const h = harness({ transcripts: ["How much is Pro?"], replies: [streams(REPLY)] });
    await askOnce(h);
    assert.deepEqual(replyVoices(h).map((a) => a.voiceId), ["kokoro:af_heart", "kokoro:af_heart"]);
    assert.ok(replyVoices(h).every((a) => a.gainDb === undefined));
    assert.ok(!h.prepared.includes("piper:en_US-lessac-medium"), "the fast voice is not even loaded");
    assert.equal(h.recorderOpens[0].engine.fastStart, undefined);
  });

  test("ON: the first piece is the female fast voice at the level of the voice it opens for; the second piece is the owner's", async () => {
    const h = harness({ fastFirstChunk: true, config: { voices: { en: "kokoro:af_heart" } }, transcripts: ["How much is Pro?"], replies: [streams(REPLY)] });
    await askOnce(h);
    const [first, second] = replyVoices(h);
    assert.equal(first.text, "The Pro plan is 149 euro a month.");
    assert.equal(first.voiceId, "piper:en_US-lessac-medium");
    assert.equal(first.gainDb, -1.7, "Piper Lessac measured -22.0 dB, Kokoro Heart -23.7 dB: brought down 1.7 dB");
    assert.equal(second.text, "Anything else?");
    assert.equal(second.voiceId, "kokoro:af_heart");
    assert.equal(second.gainDb, undefined);
  });

  test("ON: a male voice gets the male fast voice, each with its own gain; the UK voice is matched by gender, not accent", async () => {
    const h = harness({ fastFirstChunk: true, config: { voices: { en: "kokoro:bm_fable" } }, transcripts: ["How much is Pro?"], replies: [streams(REPLY)] });
    await askOnce(h);
    const [first, second] = replyVoices(h);
    assert.equal(first.voiceId, "piper:en_US-ryan-medium");
    assert.equal(first.gainDb, -4, "Ryan -21.0 dB against Fable -25.0 dB");
    assert.equal(second.voiceId, "kokoro:bm_fable");
  });

  test("ON: the greeting and the holding lines are never the fast voice — they are cached and already ready", async () => {
    const h = harness({ fastFirstChunk: true, transcripts: ["How much is Pro?"], replies: [streams(REPLY)] });
    await askOnce(h);
    const cached = h.synthArgs.filter((a) => a.cache);
    assert.ok(cached.length >= 6, "the greeting's pieces and the pre-warmed fillers");
    assert.ok(cached.every((a) => a.voiceId === "kokoro:af_heart" && a.gainDb === undefined));
  });

  test("ON: EVERY reply opens with the fast voice, not just the first of the call", async () => {
    const h = harness({ fastFirstChunk: true, transcripts: ["How much is Pro?", "And Lite?"], replies: [streams(REPLY), streams("Lite is 59 euro a month. Anything else?")] });
    await h.session.start();
    for (let i = 0; i < 2; i++) {
      h.advance(5000);
      h.hear({ type: "start" }, utterance);
      h.advance(1);
      await h.settle();
    }
    const voices = replyVoices(h).map((a) => a.voiceId);
    assert.deepEqual(voices, ["piper:en_US-lessac-medium", "kokoro:af_heart", "piper:en_US-lessac-medium", "kokoro:af_heart"]);
  });

  test("ON: a reply in Urdu is untouched — there is no fast Urdu voice", async () => {
    const h = harness({
      fastFirstChunk: true,
      config: { replyLanguage: "ur" },
      transcripts: ["آپ کے اوقات کیا ہیں؟"],
      replies: [streams("ہمارے اوقات صبح نو بجے سے شام چھ بجے تک ہیں۔ کیا مزید کچھ پوچھنا ہے؟")],
    });
    await askOnce(h);
    const used = replyVoices(h).map((a) => a.voiceId);
    assert.ok(used.length >= 2);
    assert.ok(used.every((id) => id === "kokoro:hf_alpha"), used.join(", "));
  });

  test("ON: an owner who already chose a fast voice gets it for the whole reply — there is nothing to switch from", async () => {
    const h = harness({ fastFirstChunk: true, config: { voices: { en: "piper:en_US-ryan-medium" } }, transcripts: ["How much is Pro?"], replies: [streams(REPLY)] });
    await askOnce(h);
    assert.deepEqual(replyVoices(h).map((a) => a.voiceId), ["piper:en_US-ryan-medium", "piper:en_US-ryan-medium"]);
    assert.ok(replyVoices(h).every((a) => a.gainDb === undefined));
  });

  test("ON, but the fast voice is not installed: the whole reply is the owner's voice, never a stand-in", async () => {
    const h = harness({ fastFirstChunk: true, installedVoices: ["kokoro:af_heart", "kokoro:hf_alpha"], transcripts: ["How much is Pro?"], replies: [streams(REPLY)] });
    await askOnce(h);
    assert.deepEqual(replyVoices(h).map((a) => a.voiceId), ["kokoro:af_heart", "kokoro:af_heart"]);
    assert.equal(h.recorderOpens[0].engine.fastStart, undefined);
  });

  test("the fast voice is loaded in the background with the others, and the call's record says it is in use", async () => {
    const h = harness({ fastFirstChunk: true, transcripts: [], replies: [] });
    await h.session.start();
    assert.ok(h.prepared.includes("piper:en_US-lessac-medium"));
    assert.equal(h.recorderOpens[0].engine.fastStart, "piper:en_US-lessac-medium");
  });

  test("the timeline names the voice that made the first sound, so a call can be judged afterwards", async () => {
    const h = harness({ fastFirstChunk: true, transcripts: ["How much is Pro?"], replies: [streams(REPLY)] });
    await askOnce(h);
    const first = h.recorded.events.find((e) => e.type === "tts.first_audio");
    assert.equal(first.data.voice, "piper:en_US-lessac-medium");
    assert.equal(first.data.fastStart, true);
    assert.equal(first.data.gainDb, -1.7);
  });

  test("the fast piece cannot hide a slow machine: its quick synthesis stays out of the speed that decides tts.slow", async () => {
    // The fast voice takes 0.1 s per second of speech on ANY machine; the natural voice takes 1.3 s — slower than it
    // plays. The running ratio is what tells the timeline "this machine cannot keep up": counting the fast piece
    // in would drag it down (1.3 → ~1.13 after this reply) and a slow machine would look better than it is.
    const h = harness({
      fastFirstChunk: true,
      transcripts: ["When are you open?"],
      replies: [streams("Our clinic is open from nine in the morning until six in the evening, Monday to Saturday. We also open on Sunday.")],
      speechMs: 1000,
      synthMsFor: (a) => (a.voiceId.startsWith("piper:") ? 100 : 1300),
    });
    await askOnce(h);
    assert.deepEqual(replyVoices(h).map((a) => a.voiceId), ["piper:en_US-lessac-medium", "kokoro:af_heart", "kokoro:af_heart"]);
    assert.equal(h.recorded.events.filter((e) => e.type === "tts.slow").length, 1, "and it is still reported, once");
    assert.ok(Math.abs(h.session.ttsRatio - 1.3) < 1e-9, `the ratio is the natural voice's alone, not ${h.session.ttsRatio}`);
  });

  test("a fixed line (cached) is never the fast voice, whichever turn it is spoken in", async () => {
    const h = harness({ fastFirstChunk: true, transcripts: [], replies: [] });
    await h.session.start();
    const before = h.synthArgs.length;
    await h.session.speak(h.session.newTurn(5), "Please hold on a moment.", { language: "en", cache: true });
    const [spoken] = h.synthArgs.slice(before);
    assert.equal(spoken.voiceId, "kokoro:af_heart");
    assert.equal(spoken.gainDb, undefined);
  });

  test("a failed fast piece does not end the reply: the next piece is simply the first one that got through", async () => {
    const h = harness({ fastFirstChunk: true, transcripts: ["How much is Pro?"], replies: [streams(REPLY)] });
    const realSynth = h.session.tts.synthesize;
    let failed = false;
    h.session.tts.synthesize = async (args) => {
      if (!failed && args.voiceId?.startsWith("piper:")) {
        failed = true;
        throw new Error("piper broke");
      }
      return realSynth(args);
    };
    await askOnce(h);
    assert.ok(h.recorded.events.some((e) => e.type === "tts.failed"));
    assert.equal(h.sent.audio.length > 3, true, "the second piece was still spoken after the greeting");
  });
});

describe("the echo guard in the call: the agent's own voice is not the caller", () => {
  /** A stand-in for echo-guard.js with the answers the test dictates; records what the session fed it. */
  function fakeEcho({ own = false, span = false } = {}) {
    const fake = {
      own,
      span,
      position: 32000,
      references: [],
      callerChunks: 0,
      cuts: [],
      starts: 0,
      checks: 0,
      spans: [],
      pushCaller() { fake.callerChunks++; },
      pushReference(samples, sampleRate, playsAtMs) { fake.references.push({ n: samples.length, sampleRate, playsAtMs }); },
      cutReference(atMs) { fake.cuts.push(atMs); },
      speechStarted() { fake.starts++; },
      bargeCheck() { fake.checks++; return { own: fake.own, verdict: { echo: fake.own, reason: fake.own ? "echo" : "no_match", correlation: 0.9, lagMs: 300 } }; },
      assessSpan(from, to) { fake.spans.push([from, to]); return { echo: fake.span, windows: 1, reason: "echo" }; },
    };
    return fake;
  }

  /** The reply "We open at nine every weekday." is being spoken, with more on the way. */
  async function talkingAgent(extra = {}) {
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
      ...extra,
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return { h, release };
  }

  test("OFF unless the gateway asks: no guard object, and the barge-in is exactly as before", async () => {
    const { h, release } = await talkingAgent();
    assert.equal(h.session.echo, null);
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 10 });
    assert.equal(h.sent.clears, 1);
    release();
    await h.settle();
    assert.ok(!h.recorded.events.some((e) => e.type === "echo.suppressed"));
  });

  test("ON builds a real guard", () => {
    const h = harness({ echoGuard: true });
    assert.ok(h.session.echo instanceof EchoGuard);
  });

  test("sound the guard says is the agent's own voice does NOT interrupt it, and is logged once", async () => {
    const { h, release } = await talkingAgent({ echoGuard: true });
    const echo = fakeEcho({ own: true });
    h.session.echo = echo;
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 10 });
    h.hear({ type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 42 });
    h.hear({ type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 74 });
    assert.equal(h.sent.clears, 0, "the agent keeps talking");
    assert.equal(h.session.interruptions, 0);
    assert.equal(echo.checks, 3, "asked at every ongoing report, so a person who joins in is caught at once");
    assert.equal(h.recorded.events.filter((e) => e.type === "echo.suppressed").length, 1, "one log line per stretch of speech");
    assert.equal(h.session.echoSuppressed, 1);
    assert.equal(echo.starts, 1, "a new stretch of speech starts the guard's grace over");

    // and the moment the sound stops matching the agent's voice, it IS an interruption
    echo.own = false;
    h.hear({ type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 106 });
    assert.equal(h.sent.clears, 1);
    assert.equal(h.session.interruptions, 1);
    release();
    await h.settle();
  });

  test("a short sound is not even asked about (below the barge-in length), and a quiet agent is not asked at all", async () => {
    const { h, release } = await talkingAgent({ echoGuard: true });
    const echo = fakeEcho({ own: true });
    h.session.echo = echo;
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs - 100 });
    assert.equal(echo.checks, 0);
    release();
    await h.settle();
    h.advance(20_000); // everything has finished playing
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 10 });
    assert.equal(echo.checks, 0, "the agent is not audible: nothing to take for an echo");
  });

  test("while the agent is only THINKING (no audio yet) there is no echo to take for the caller: the guard is not consulted", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = harness({
      echoGuard: true,
      transcripts: ["What are your hours?"],
      replies: [
        async () => {
          await gate; // the model has said nothing yet
          return { reply: "We open at nine.", sources: [], timings: {} };
        },
      ],
    });
    await h.session.start();
    h.advance(30_000); // the greeting has long finished playing
    const echo = fakeEcho({ own: true });
    h.session.echo = echo;
    h.hear({ type: "start" }, utterance);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 10 });
    assert.equal(echo.checks, 0, "nothing the agent played could be coming back");
    assert.equal(h.sent.clears, 1, "the caller talking over a thinking agent is a barge-in, as before");
    release();
    await h.settle();
  });

  test("FAIL OPEN: a guard that throws leaves today's behaviour, the agent is interrupted", async () => {
    const { h, release } = await talkingAgent({ echoGuard: true });
    const echo = fakeEcho();
    echo.bargeCheck = () => {
      throw new Error("boom");
    };
    h.session.echo = echo;
    const quiet = console.error;
    console.error = () => {};
    try {
      h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 10 });
    } finally {
      console.error = quiet;
    }
    assert.equal(h.sent.clears, 1);
    release();
    await h.settle();
  });

  test("the guard is fed what the call hears and what the agent plays, and told when the agent is cut off", async () => {
    const { h, release } = await talkingAgent({ echoGuard: true });
    const echo = fakeEcho();
    h.session.echo = echo;
    h.session.onAudio(new Float32Array(512));
    assert.ok(echo.callerChunks >= 1);
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 10 });
    assert.equal(h.sent.clears, 1);
    assert.equal(echo.cuts.length, 1, "a barge-in tells the guard the rest of the reply will not be heard");
    release();
    await h.settle();

    // audio is placed on the guard's timeline when it is sent
    const h2 = harness({ echoGuard: true });
    const echo2 = fakeEcho();
    const realStart = h2.session.start.bind(h2.session);
    h2.session.start = async () => {
      h2.session.echo = echo2; // swapped in before the greeting is spoken
      return realStart();
    };
    await h2.session.start();
    assert.ok(echo2.references.length >= 1, "the greeting was handed to the guard");
    assert.equal(echo2.references[0].sampleRate, 22050);
    assert.equal(typeof echo2.references[0].playsAtMs, "number");
  });

  test("an utterance that is the agent's own voice is not transcribed, not answered, and the call goes on listening", async () => {
    const h = harness({ echoGuard: true, transcripts: ["we open at nine every weekday"] });
    await h.session.start();
    const echo = fakeEcho({ span: true });
    h.session.echo = echo;
    h.hear({ type: "start" }, { type: "utterance", samples: new Float32Array(16000), durationMs: 1000, startSample: 8000, endSample: 24000 });
    await h.settle();
    assert.deepEqual(echo.spans, [[8000, 24000]], "judged over exactly where the detector says it lay");
    assert.equal(h.calls.length, 0, "no brain call");
    assert.equal(h.recorded.turns.length, 0);
    const dropped = h.recorded.events.filter((e) => e.type === "utterance.echo_dropped");
    assert.equal(dropped.length, 1);
    assert.equal(h.session.echoDropped, 1);
    assert.notEqual(h.session.state, CALL_STATES.THINKING);
  });

  test("an utterance the guard does not recognise is answered as usual", async () => {
    const h = harness({
      echoGuard: true,
      transcripts: ["What are your hours?"],
      replies: [streams("We open at nine.")],
    });
    await h.session.start();
    h.session.echo = fakeEcho({ span: false });
    h.advance(5000);
    h.hear({ type: "start" }, { type: "utterance", samples: new Float32Array(16000), durationMs: 1000, startSample: 8000, endSample: 24000 });
    await h.settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.recorded.turns.length, 1);
    assert.ok(!h.recorded.events.some((e) => e.type === "utterance.echo_dropped"));
  });

  test("FAIL OPEN: an utterance whose place in the stream is unknown is never dropped", async () => {
    const h = harness({ echoGuard: true, transcripts: ["What are your hours?"], replies: [streams("We open at nine.")] });
    await h.session.start();
    const echo = fakeEcho({ span: true }); // would say "echo" if it were asked
    h.session.echo = echo;
    h.advance(5000);
    h.hear({ type: "start" }, utterance); // the shared fixture has no startSample/endSample
    await h.settle();
    assert.equal(echo.spans.length, 0, "not asked");
    assert.equal(h.calls.length, 1);
  });

  test("the end-of-call log says how often the guard acted", async () => {
    const { h, release } = await talkingAgent({ echoGuard: true });
    h.session.echo = fakeEcho({ own: true });
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 10 });
    release();
    await h.settle();
    await h.session.hangup();
    const ended = h.recorded.events.find((e) => e.type === "call.ended");
    assert.equal(ended.data.echoSuppressed, 1);
    assert.equal(ended.data.echoDropped, 0);
  });
});

/**
 * A TRANSFER THE CALLER NEVER HEARD ANNOUNCED, AND A CALL THAT WOULD NOT END (CLAUDE.md §6.26).
 * Reproduced from three real console calls, where (1) a caller talking over the reply was transferred anyway, in silence,
 * (2) "Goodbye." did not end the call because a "please rephrase" plan was mistaken for a transfer, and (3) a transcript in
 * a script nobody speaks to this agent was answered as a question.
 */
describe("a transfer is only placed once the caller has heard who they are being put through to", () => {
  const CONTACTS = [{ id: "c1", role: "Representative", name: "Adan", phone: "+923001234567" }];
  const ANNOUNCEMENT = "I'm connecting you to Adan, our Representative. Please stay on the line.";
  const handoffResult = (text) => ({ reply: text, sources: [], model: "t", timings: {}, handoff: { kind: "handoff", reason: "not_understood", contacts: CONTACTS, summary: "x", announcement: ANNOUNCEMENT } });

  test("the caller talks over the reply before a word of it is heard: no transfer, the state is put back, and what they were saying is answered", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = harness({
      transcripts: ["Oui.", "Zero three four zero five two one six five four two."],
      replies: [
        async ({ onChunk }) => {
          await gate; // the model is still thinking when the caller speaks
          const text = `May I have your phone number, please? ${ANNOUNCEMENT}`;
          onChunk(text);
          return handoffResult(text);
        },
        streams("Thank you. I have your number."),
      ],
      transfer: async () => ({ connected: true, simulated: true }),
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 200 });
    release();
    await h.pump(8000);
    await h.settle();

    assert.equal(h.recorded.turns[0].interrupted, true);
    assert.equal(h.sent.transfers.length, 0, "nobody is rung for a caller who never heard it announced");
    assert.equal(h.sent.closed, null, "the call goes on");
    const cancelled = h.recorded.events.find((e) => e.type === "handoff.cancelled");
    assert.ok(cancelled, "logged");
    assert.equal(cancelled.data.reason, "caller_spoke");
    assert.ok(!h.recorded.events.some((e) => e.type === "handoff.started" || e.type === "handoff.completed"));
    assert.deepEqual(h.handoffFailures, [{ tenantId: "t1", conversationId: "conv-1" }], "the conversation is not left marked 'passed on'");

    // What the caller was saying is not lost: it is the next turn.
    h.advance(1000);
    h.hear(utterance);
    await h.pump(8000);
    await h.settle();
    assert.equal(h.calls.length, 2);
    assert.ok(h.spoken.some((s) => !s.cache && s.text === "Thank you. I have your number."));
    assert.equal(h.sent.closed, null);
  });

  test("the caller starts talking while the announcement is playing: the transfer is not placed either", async () => {
    const h = harness({
      transcripts: ["Do you do catering for big events?"],
      replies: [async ({ onChunk }) => { onChunk(ANNOUNCEMENT); return handoffResult(ANNOUNCEMENT); }],
      transfer: async () => ({ connected: true, simulated: true }),
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(300); // the announcement is sent and playing; the session waits for it to finish
    assert.equal(h.sent.transfers.length, 0);
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 200 }); // the caller talks over it
    await h.pump(8000);
    await h.settle();
    assert.equal(h.sent.transfers.length, 0);
    assert.equal(h.sent.closed, null);
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.cancelled"));
    assert.equal(h.handoffFailures.length, 1);
  });

  test("speech nobody could read ends in a transfer: the same rule — talk over the line that names who they are put through to, and nobody is rung", async () => {
    const decisions = [{ kind: "rephrase" }, { kind: "handoff", reason: "not_understood", contacts: CONTACTS, summary: "x", announcement: ANNOUNCEMENT }];
    const h = harness({ transcripts: ["", ""], noteUnheard: async () => decisions.shift(), transfer: async () => ({ connected: true }) });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(300);
    h.hear({ type: "start" }, { type: "ongoing", speechMs: BARGE_IN.minSpeechMs + 200 });
    await h.pump(8000);
    await h.settle();
    assert.equal(h.sent.transfers.length, 0);
    assert.equal(h.sent.closed, null);
    assert.ok(h.recorded.events.some((e) => e.type === "handoff.cancelled"));
  });

  test("when nothing interrupts, the announcement plays and THEN the transfer is placed (unchanged)", async () => {
    const h = harness({
      transcripts: ["Do you do catering for big events?"],
      replies: [async ({ onChunk }) => { onChunk(ANNOUNCEMENT); return handoffResult(ANNOUNCEMENT); }],
      transfer: async () => ({ connected: true, simulated: true }),
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(300);
    assert.equal(h.sent.transfers.length, 0, "not before the announcement has played");
    await h.pump(8000);
    await h.settle();
    assert.equal(h.sent.transfers.length, 1);
    assert.equal(h.sent.closed, END_REASONS.TRANSFERRED);
    assert.ok(!h.recorded.events.some((e) => e.type === "handoff.cancelled"));
  });
});

describe("a call that has said goodbye ends", () => {
  const goodbye = (handoff) => async ({ onChunk }) => {
    const text = "Thank you for calling KO Restaurants. Goodbye.";
    onChunk(text);
    return { reply: text, sources: [], handoff, model: "t", timings: {} };
  };

  test("a 'please rephrase' plan is not a transfer: the agent said goodbye, so the call ends by itself", async () => {
    const h = harness({ transcripts: ["No, nothing."], replies: [goodbye({ kind: "rephrase", reason: null, callback: false })] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(15000);
    await h.settle();
    const closing = h.recorded.events.find((e) => e.type === "call.closing");
    assert.equal(closing?.data.trigger, "agent_farewell");
    assert.equal(h.sent.closed, END_REASONS.AGENT_GOODBYE);
    assert.ok(!h.recorded.events.some((e) => e.type === "silence.check_in"), "never asked 'are you still there?' after goodbye");
  });

  test("neither does the offer of a call-back (the business is closed) hold a goodbye back", async () => {
    const h = harness({ transcripts: ["No thanks."], replies: [goodbye({ kind: "unavailable", reason: "closed", callback: true })] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(15000);
    await h.settle();
    assert.equal(h.sent.closed, END_REASONS.AGENT_GOODBYE);
  });

  test("a goodbye that the owner's switch does not end is never followed by 'Are you still there?' — the silent line just ends", async () => {
    const h = harness({ config: { autoEndCalls: false }, transcripts: ["Thanks."], replies: [goodbye(undefined)] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(5000);
    await h.settle();
    assert.equal(h.sent.closed, null, "the switch is off: the call is not ended by the decision");
    await h.pump(SILENCE.checkInAfterMs + 2000);
    assert.ok(!h.recorded.events.some((e) => e.type === "silence.check_in"));
    assert.ok(h.recorded.events.some((e) => e.type === "silence.ending" && e.data?.afterFarewell === true));
    assert.equal(h.sent.closed, END_REASONS.AGENT_GOODBYE);
  });

  test("silence after something that is NOT a goodbye still gets the check-in first (unchanged)", async () => {
    const h = harness({ transcripts: ["What are your hours?"], replies: [streams("We open at nine. Anything else?")] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(3000);
    await h.settle();
    await h.pump(SILENCE.checkInAfterMs + 2000);
    assert.ok(h.recorded.events.some((e) => e.type === "silence.check_in"));
    assert.equal(h.sent.closed, null, "it asked first");
  });

  test("a goodbye does not leave the check-in disabled for later: after a fixed line that is NOT a goodbye the agent asks as before", async () => {
    // Goodbye (switch off, so the call stays), then the caller says something the recogniser cannot read → the agent asks them to repeat.
    const h = harness({ config: { autoEndCalls: false }, transcripts: ["Thanks.", ""], replies: [goodbye(undefined)] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(3000);
    await h.settle();
    h.advance(1000);
    h.hear({ type: "start" }, utterance); // empty transcript, long enough to be a person: "Sorry, I didn't catch that"
    await h.pump(2000);
    await h.settle();
    assert.ok(h.recorded.events.some((e) => e.type === "speech.unheard"));
    await h.pump(SILENCE.checkInAfterMs + 2000);
    assert.ok(h.recorded.events.some((e) => e.type === "silence.check_in"), "the agent's last words were a request to repeat, not a goodbye");
  });

  test("any other line the agent says after a goodbye makes the goodbye no longer its last word", async () => {
    const h = harness({ config: { autoEndCalls: false }, transcripts: ["Thanks."], replies: [goodbye(undefined)] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(3000);
    await h.settle();
    await h.session.speakFixed("Sorry, I didn't catch that.", "en"); // e.g. a call-back line, a repeat request — anything that is not a goodbye
    await h.pump(SILENCE.checkInAfterMs + 2000);
    assert.ok(h.recorded.events.some((e) => e.type === "silence.check_in"));
    assert.ok(!h.recorded.events.some((e) => e.type === "silence.ending" && e.data?.afterFarewell === true));
  });

  test("a sound from the caller after the goodbye (a cough the recogniser could not read) restores the ordinary check-in", async () => {
    const h = harness({ config: { autoEndCalls: false }, transcripts: ["Thanks.", ""], replies: [goodbye(undefined)] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.pump(3000);
    await h.settle();
    h.advance(1000);
    h.hear({ type: "start" }, { type: "utterance", samples: new Float32Array(4000), durationMs: 300 }); // a blip: not unheard, nothing said
    await h.settle();
    await h.pump(SILENCE.checkInAfterMs + 2000);
    assert.ok(h.recorded.events.some((e) => e.type === "silence.check_in"), "somebody is on the line: ask");
    assert.ok(!h.recorded.events.some((e) => e.type === "silence.ending" && e.data?.afterFarewell === true));
  });
});

describe("a transcript the agent cannot read is 'unheard', not a question", () => {
  test("Cyrillic from a caller who spoke English or Urdu (the recogniser's language guess was wrong) is asked to repeat, with no brain call", async () => {
    const h = harness({ transcripts: ["Нет, ничего."], noteUnheard: async () => null });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls.length, 0, "nothing sent to the brain");
    assert.equal(h.recorded.turns.length, 0);
    const empty = h.recorded.events.find((e) => e.type === "stt.empty");
    assert.equal(empty.data.script, "Cyrillic");
    assert.ok(h.recorded.events.some((e) => e.type === "speech.unheard"));
    assert.ok(h.spoken.some((x) => x.text === "Sorry, I didn't catch that. Could you say it again, please?" || x.text === "I'm sorry, the line wasn't clear. Could you repeat that for me?"));
  });

  test("a short blip in that script is plain noise (not long enough to be a person we failed)", async () => {
    const h = harness({ transcripts: ["Нет."], noteUnheard: async () => null });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, { type: "utterance", samples: new Float32Array(4000), durationMs: 300 });
    await h.settle();
    assert.equal(h.calls.length, 0);
    assert.ok(!h.recorded.events.some((e) => e.type === "speech.unheard"));
  });

  test("Urdu script and English are still answered", async () => {
    const h = harness({ transcripts: ["آپ کے اوقات کیا ہیں؟", "What are your hours?"], replies: [streams("Nine to six."), streams("Nine to six.")] });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.calls.length, 2);
  });
});

describe("what the caller answered is not logged as a question the documents failed", () => {
  test("a name given after the agent asked for one is 'conversational'; a real request nothing answered is still a gap", async () => {
    const h = harness({
      transcripts: ["I want to order something.", "My name is Ali Khan."],
      replies: [streams("Of course. May I have your name, please?"), streams("Thank you, Ali.")],
    });
    await h.session.start();
    h.advance(5000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    h.advance(8000);
    h.hear({ type: "start" }, utterance);
    await h.settle();
    assert.equal(h.recorded.turns[1].outcome, "conversational");
    assert.equal(h.recorded.turns[0].outcome, "no_knowledge");
  });
});
