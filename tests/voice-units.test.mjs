import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { SentenceChunker, sanitizeForSpeech } from "@/lib/voice/sentences";
import { classifyTurn, INTENTS, OUTCOMES } from "@/lib/voice/intent";
import { issueTicket, createTicketVerifier, ticketSecret } from "@/lib/voice/ticket";
import { pcm16ToFloat32, float32ToPcm16 } from "@/lib/voice/audio";
import { chooseSpokenLanguage } from "@/lib/voice/spoken-language";
import { createSerialQueue } from "@/lib/voice/serial";
import { median } from "@/lib/voice/recorder";
import { decodeClientFrame, createBrowserTransport } from "@/lib/voice/transports/browser";
import { SERVER } from "@/lib/voice/protocol";
import { VOICES, DEFAULT_VOICES, SPOKEN_LANGUAGES, PREVIEW_TEXT, getVoice, voiceFor, voiceSelectionProblems } from "@/lib/voice/speech/voices";
import { KOKORO_MODEL, PIPER_VOICES } from "@/lib/voice/speech/models";
import { encodeWav } from "@/lib/voice/audio";
import { createSpeechToText, groqTranscriber } from "@/lib/voice/speech/stt";
import { callVocabulary, correctTranscript, soundKey } from "@/lib/voice/vocabulary";
import { buildSystemInstruction } from "@/lib/agent/prompt";
import { buildVoiceGreeting, voiceLine } from "@/lib/agent/prompt";
import { detectSearchConfig } from "@/lib/agent/language";

const stream = (text, size = 3) => {
  const chunker = new SentenceChunker();
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(...chunker.push(text.slice(i, i + size)));
  return [...out, ...chunker.flush()];
};

describe("SentenceChunker — streaming text into speakable sentences", () => {
  test("emits each chunk as soon as it is complete, however the stream is cut", () => {
    const text = "Of course. Our Pro plan is 149 euro a month. Would you like more details?";
    for (const size of [1, 2, 5, 17, 1000]) {
      assert.deepEqual(stream(text, size), ["Of course. Our Pro plan is 149 euro a month.", "Would you like more details?"]);
    }
  });

  test("the first sentence is out before the rest has arrived", () => {
    const chunker = new SentenceChunker();
    assert.deepEqual(chunker.push("We open at nine every weekday. We clo"), ["We open at nine every weekday."]);
    assert.deepEqual(chunker.push("se at six."), []);
    assert.deepEqual(chunker.flush(), ["We close at six."]);
  });

  test("a tiny first sentence waits for the next and goes out with it (alone it cannot cover the next synthesis)", () => {
    const chunker = new SentenceChunker();
    assert.deepEqual(chunker.push("Sure! "), []);
    assert.deepEqual(chunker.push("The Pro plan is 149 euro. And"), ["Sure! The Pro plan is 149 euro."]);
  });

  test("PROGRESSIVE sizes: short first chunk, each later one within L1 + 0.6 × already sent, never cut mid-word", () => {
    const reply =
      "Our support hours depend on your plan. For Starter and Lite plans support is available Monday to Friday " +
      "from nine in the morning until six in the evening Central European Time which covers most of Europe and " +
      "for Pro and Unlimited plans we also answer on Saturday mornings because many of those customers run shops. " +
      "Would you like me to connect you with our team for more details about the plan that suits you best?";
    const chunks = stream(reply, 3);
    assert.ok(chunks[0].length <= 56, "first chunk is short");
    let sent = 0;
    for (const [i, c] of chunks.entries()) {
      if (i > 0) assert.ok(c.length <= Math.max(48, chunks[0].length + 0.6 * sent) + 1, `chunk ${i} too long: ${c.length}`);
      sent += c.length;
    }
    // Every word survives intact, in order.
    assert.equal(chunks.join(" "), reply);
    // Breaks prefer clause boundaries over plain spaces.
    assert.ok(chunks.some((c) => /^(which|because) /.test(c)), chunks.join(" | "));
  });

  test("decimals, versions and abbreviations do not end a sentence", () => {
    assert.deepEqual(stream("It costs 149.99 euro on v2.1 today. Ask Dr. Rossi, e.g. on Monday."), [
      "It costs 149.99 euro on v2.1 today.",
      "Ask Dr. Rossi, e.g. on Monday.",
    ]);
  });

  test("a first sentence too long for the first chunk is cut at a comma, so the voice can start sooner", () => {
    assert.deepEqual(stream("Sure, our support team is available Monday to Friday, nine to six. Anything else?"), [
      "Sure, our support team is available Monday to Friday,",
      "nine to six.",
      "Anything else?",
    ]);
    // One that fits is spoken whole — a comma alone is no reason to cut.
    assert.deepEqual(stream("Yes, we open at nine and close at six."), ["Yes, we open at nine and close at six."]);
  });

  test("Urdu punctuation ends sentences (۔ and ؟); the Urdu comma (،) is a break point when one is needed", () => {
    assert.deepEqual(stream("ہمارے دفتر کے اوقات، پیر سے جمعہ ہیں۔ کیا کچھ اور؟ جی ہاں"), [
      "ہمارے دفتر کے اوقات، پیر سے جمعہ ہیں۔",
      "کیا کچھ اور؟",
      "جی ہاں",
    ]);
    const long = "ہمارے سپورٹ کے اوقات آپ کے پلان پر منحصر ہیں، اسٹارٹر پلان کے لیے پیر سے جمعہ صبح نو سے شام چھ بجے تک۔";
    assert.equal(stream(long)[0], "ہمارے سپورٹ کے اوقات آپ کے پلان پر منحصر ہیں،");
  });

  test("a line break ends a sentence", () => {
    assert.deepEqual(stream("Our opening hours are listed below\nMonday to Friday"), [
      "Our opening hours are listed below",
      "Monday to Friday",
    ]);
  });

  test("a long run with no sentence end is cut at a comma rather than held back", () => {
    const long = "We offer cleaning, whitening, implants, braces, check-ups, x-rays, emergency visits, children's care, ".repeat(3);
    const out = stream(long, 10);
    assert.ok(out.length > 1, "split into several pieces");
    for (const piece of out) assert.ok(piece.length <= 220, `piece too long: ${piece.length}`);
    assert.equal(out.join(" ").replace(/\s+/g, " "), long.trim().replace(/\s+/g, " "));
  });

  test("markdown, bullets and URLs never reach the voice", () => {
    assert.equal(sanitizeForSpeech("**Pro** plan: see https://example.com/pricing"), "Pro plan: see");
    assert.equal(sanitizeForSpeech("- first item"), "first item");
    assert.equal(sanitizeForSpeech("## Hours"), "Hours");
    assert.equal(sanitizeForSpeech("[our site](https://x.y)"), "our site");
  });
});

describe("classifyTurn — intent and outcome, rule-based", () => {
  test("giving details to a booking is conversation, not an unanswered question", () => {
    assert.equal(classifyTurn({ callerText: "0300 1234567", sources: [], requestState: "ask" }).outcome, OUTCOMES.CONVERSATIONAL);
    assert.equal(classifyTurn({ callerText: "yes", sources: [], requestState: "saved" }).outcome, OUTCOMES.CONVERSATIONAL);
    // …but a question with no answer in the documents, with nothing being collected, still is.
    assert.equal(classifyTurn({ callerText: "Do you sell bikes?", sources: [], requestState: "idle" }).outcome, OUTCOMES.NO_KNOWLEDGE);
    assert.equal(classifyTurn({ callerText: "Do you sell bikes?", sources: [] }).outcome, OUTCOMES.NO_KNOWLEDGE);
    // and a failed turn is still failed.
    assert.equal(classifyTurn({ callerText: "0300", sources: [], requestState: "ask", failed: true }).outcome, OUTCOMES.FAILED);
  });

  test("a grounded question is answered; an ungrounded one is the business's gap list", () => {
    assert.deepEqual(classifyTurn({ callerText: "How much is the Pro plan?", sources: ["03-pricing.docx"] }), {
      intent: INTENTS.QUESTION,
      outcome: OUTCOMES.ANSWERED,
      topic: "pricing",
    });
    assert.equal(classifyTurn({ callerText: "Do you sell car insurance?", sources: [] }).outcome, OUTCOMES.NO_KNOWLEDGE);
  });

  test("a follow-up is a turn whose search was REWRITTEN, not one that merely triggered", () => {
    assert.equal(classifyTurn({ callerText: "And the Pro one?", trigger: "heuristic", rewriteStatus: "rewritten" }).intent, INTENTS.FOLLOWUP);
    assert.equal(classifyTurn({ callerText: "What about the weather?", trigger: "heuristic", rewriteStatus: "unchanged" }).intent, INTENTS.QUESTION);
  });

  test("asking for a person, in English, Urdu and Roman Urdu", () => {
    for (const text of ["Can I speak to a human please", "put me through to an operator", "مجھے کسی انسان سے بات کرنی ہے", "مینیجر سے بات کروائیں", "kisi insan se baat karni hai", "manager se baat karwa dein"]) {
      const result = classifyTurn({ callerText: text, sources: ["x"] });
      assert.equal(result.intent, INTENTS.HUMAN_REQUEST, text);
      assert.equal(result.outcome, OUTCOMES.HANDOFF_REQUESTED, text);
    }
  });

  test("small talk is conversational, never 'no knowledge'", () => {
    assert.equal(classifyTurn({ callerText: "Hello!" }).intent, INTENTS.GREETING);
    assert.equal(classifyTurn({ callerText: "السلام علیکم" }).intent, INTENTS.GREETING);
    assert.equal(classifyTurn({ callerText: "Assalam o alaikum" }).intent, INTENTS.GREETING);
    assert.equal(classifyTurn({ callerText: "thanks" }).intent, INTENTS.ACKNOWLEDGEMENT);
    assert.equal(classifyTurn({ callerText: "شکریہ" }).intent, INTENTS.ACKNOWLEDGEMENT);
    assert.equal(classifyTurn({ callerText: "Okay, goodbye" }).intent, INTENTS.GOODBYE);
    assert.equal(classifyTurn({ callerText: "شکریہ، خدا حافظ" }).intent, INTENTS.GOODBYE);
    assert.equal(classifyTurn({ callerText: "theek hai, Allah hafiz" }).intent, INTENTS.GOODBYE);
    for (const text of ["Hello!", "thanks", "goodbye", "خدا حافظ"]) {
      assert.equal(classifyTurn({ callerText: text }).outcome, OUTCOMES.CONVERSATIONAL, text);
    }
  });

  test("a failed turn is failed whatever was asked", () => {
    assert.equal(classifyTurn({ callerText: "How much is Pro?", failed: true }).outcome, OUTCOMES.FAILED);
  });
});

describe("session tickets", () => {
  const secret = "test-secret";

  test("a fresh ticket opens exactly one call for its tenant", () => {
    const verifier = createTicketVerifier({ secret });
    const { ticket } = issueTicket({ tenantId: "clinic-1", ttlMs: 60_000, secret });
    assert.deepEqual(verifier.verify(ticket), { ok: true, tenantId: "clinic-1", agentId: null, line: null, resume: null });
    assert.deepEqual(verifier.verify(ticket), { ok: false, reason: "replayed" });
  });

  test("a ticket carries the agent it was issued for, and the agent cannot be swapped", () => {
    const verifier = createTicketVerifier({ secret });
    const { ticket } = issueTicket({ tenantId: "chain", agentId: "agent-dublin", ttlMs: 60_000, secret });
    assert.deepEqual(verifier.verify(ticket), { ok: true, tenantId: "chain", agentId: "agent-dublin", line: null, resume: null });

    const [payload, sig] = issueTicket({ tenantId: "chain", agentId: "agent-dublin", ttlMs: 60_000, secret }).ticket.split(".");
    const otherAgent = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), a: "agent-london" })).toString("base64url");
    assert.equal(verifier.verify(`${otherAgent}.${sig}`).reason, "signature");
  });

  test("expired, forged, tampered and malformed tickets are refused", () => {
    let now = 1_000_000;
    const verifier = createTicketVerifier({ secret, now: () => now });
    const { ticket } = issueTicket({ tenantId: "a", ttlMs: 60_000, secret, now });
    now += 60_001;
    assert.equal(verifier.verify(ticket).reason, "expired");

    const forged = issueTicket({ tenantId: "a", ttlMs: 60_000, secret: "other", now }).ticket;
    assert.equal(verifier.verify(forged).reason, "signature");

    const [payload, sig] = issueTicket({ tenantId: "a", ttlMs: 60_000, secret, now }).ticket.split(".");
    const otherTenant = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), t: "victim" })).toString("base64url");
    assert.equal(verifier.verify(`${otherTenant}.${sig}`).reason, "signature");

    for (const bad of ["", "abc", "a.b.c", null]) assert.equal(verifier.verify(bad).ok, false);
  });

  test("the secret fails closed in production and warns in development", () => {
    assert.equal(ticketSecret({ VOICE_SESSION_SECRET: "s" }), "s");
    assert.equal(ticketSecret({ INTERNAL_API_KEY: "k" }), "k");
    assert.equal(ticketSecret({ NODE_ENV: "production" }), null);
    assert.equal(typeof ticketSecret({ NODE_ENV: "development" }), "string");
  });
});

describe("PCM conversion", () => {
  test("float32 → PCM16 → float32 round-trips within one quantisation step, clamping out-of-range input", () => {
    const input = Float32Array.from([0, 0.5, -0.5, 1, -1, 1.7, -3, 0.123456]);
    const back = pcm16ToFloat32(float32ToPcm16(input));
    const expected = [0, 0.5, -0.5, 1, -1, 1, -1, 0.123456];
    expected.forEach((v, i) => assert.ok(Math.abs(back[i] - v) < 1 / 16000, `sample ${i}: ${back[i]} vs ${v}`));
  });

  test("reads a socket buffer at an odd byte offset and ignores a trailing odd byte", () => {
    const pcm = float32ToPcm16(Float32Array.from([0.25, -0.25]));
    const shifted = Buffer.concat([Buffer.from([7]), pcm, Buffer.from([9])]).subarray(1);
    const samples = pcm16ToFloat32(shifted);
    assert.equal(samples.length, 2);
    assert.ok(Math.abs(samples[0] - 0.25) < 1e-4);
  });

  test("client frames decode into exactly the messages the protocol defines", () => {
    assert.equal(decodeClientFrame(float32ToPcm16(new Float32Array(320)), true).samples.length, 320);
    assert.deepEqual(decodeClientFrame('{"type":"hello","ticket":"t"}', false), { kind: "hello", ticket: "t" });
    assert.deepEqual(decodeClientFrame('{"type":"playback","playing":1}', false), { kind: "playback", playing: true });
    assert.deepEqual(decodeClientFrame('{"type":"hangup"}', false), { kind: "hangup" });
    for (const bad of ["not json", '{"type":"nope"}', '{"type":"hello"}']) assert.equal(decodeClientFrame(bad, false).kind, "invalid");
  });

  test("server frames keep their message type: a timeline event travels NESTED (found live — it used to be overwritten)", () => {
    const frames = [];
    const ws = { OPEN: 1, readyState: 1, send: (d, opts) => frames.push({ d, binary: Boolean(opts?.binary) }), close() {} };
    const transport = createBrowserTransport(ws);

    transport.notify(SERVER.EVENT, { event: { seq: 1, type: "speech.ended", atMs: 10, data: null } });
    assert.deepEqual(JSON.parse(frames[0].d), { type: "event", event: { seq: 1, type: "speech.ended", atMs: 10, data: null } });
    assert.throws(() => transport.notify(SERVER.EVENT, { type: "speech.ended" }), /must not carry its own "type"/);

    // Audio: the format is announced once per sample rate, then binary PCM16 follows.
    transport.audio(new Float32Array(100), 22050);
    transport.audio(new Float32Array(100), 22050);
    assert.deepEqual(JSON.parse(frames[1].d), { type: SERVER.AUDIO_FORMAT, sampleRate: 22050 });
    assert.deepEqual(frames.slice(2).map((f) => [f.binary, f.d.length]), [[true, 200], [true, 200]]);

    // A closed socket swallows everything instead of throwing into the call.
    ws.readyState = 3;
    transport.audio(new Float32Array(10), 22050);
    transport.notify(SERVER.STATE, { state: "listening" });
    assert.equal(frames.length, 4);
  });
});

describe("spoken language and fixed agent lines", () => {
  test("an English call is always spoken in English; an Urdu call in Urdu", () => {
    assert.equal(chooseSpokenLanguage({ replyLanguage: "en", text: "The price is 149 euro." }), "en");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "en", text: "قیمت 149 روپے ہے۔" }), "en", "the business chose English");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "ur", text: "ہمارے اوقات پیر سے جمعہ ہیں۔" }), "ur");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "ur", text: "پرو پلان 149 روپے ہے۔" }), "ur");
    // A brand name inside Urdu does not flip it to English.
    assert.equal(chooseSpokenLanguage({ replyLanguage: "ur", text: "StorePulse کا پرو پلان بہترین ہے۔" }), "ur");
  });

  test("an Urdu call reads a sentence with no Urdu letters at all in English, and a bare number in the language before it", () => {
    assert.equal(chooseSpokenLanguage({ replyLanguage: "ur", text: "Smile Care Dental Clinic." }), "en");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "ur", text: "500." , previous: "ur" }), "ur");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "ur", text: "500." , previous: "en" }), "en");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "ur", text: "500." }), "ur");
  });

  test("a stored 'auto' or Italian reply language (older data) speaks English", () => {
    for (const replyLanguage of ["auto", "it", undefined]) {
      assert.equal(chooseSpokenLanguage({ replyLanguage, text: "Hello" }), "en", String(replyLanguage));
    }
  });

  test("detectSearchConfig: Urdu script is 'simple', English and Roman Urdu are 'english', short text is 'english'", () => {
    assert.equal(detectSearchConfig("ہمارا کلینک پیر سے ہفتے تک صبح دس بجے سے رات آٹھ بجے تک کھلا رہتا ہے اور اتوار کو بند ہوتا ہے۔"), "simple");
    assert.equal(detectSearchConfig("Our clinic is open from Monday to Friday and we are always available for the emergencies of our patients."), "english");
    assert.equal(detectSearchConfig("Humara clinic Monday se Saturday tak subah das baje se raat aath baje tak khula rehta hai aur Sunday ko band hota hai."), "english");
    assert.equal(detectSearchConfig("ہاں"), "english");
    assert.equal(detectSearchConfig(""), "english");
  });

  test("the Urdu greeting agrees with the voice's gender", () => {
    const female = buildVoiceGreeting({ businessName: "Nyron", replyLanguage: "ur", voices: { ur: "kokoro:hf_alpha" } });
    const male = buildVoiceGreeting({ businessName: "Nyron", replyLanguage: "ur", voices: { ur: "kokoro:hm_psi" } });
    assert.equal(female.language, "ur");
    assert.match(female.text, /سکتی ہوں؟$/);
    assert.match(male.text, /سکتا ہوں؟$/);
    // Default Urdu voice is female.
    assert.match(buildVoiceGreeting({ businessName: "this business", replyLanguage: "ur" }).text, /^السلام علیکم، کال کرنے کا شکریہ۔/);
  });

  test("on a call the model is told its voice's gender — only on voice, for the language it speaks", () => {
    const base = { businessName: "Nyron", tone: "professional", purpose: "", hours: null, capabilities: {}, timezone: "UTC" };
    const voiceMale = buildSystemInstruction({ config: { ...base, replyLanguage: "ur", voices: { ur: "kokoro:hm_omega" } }, channel: "voice" });
    assert.match(voiceMale, /VOICE: Your voice on this call is male\. .*masculine forms/);
    const voiceFemale = buildSystemInstruction({ config: { ...base, replyLanguage: "en", voices: {} }, channel: "voice" });
    assert.match(voiceFemale, /VOICE: Your voice on this call is female\. .*feminine forms/);
    const chat = buildSystemInstruction({ config: { ...base, replyLanguage: "ur", voices: {} }, channel: "chat" });
    assert.doesNotMatch(chat, /VOICE:/);
    assert.match(voiceMale, /Urdu script, never in Roman/);
  });

  test("filler lines rotate, so a slow provider does not make the agent repeat itself", () => {
    const en = [0, 1, 2].map((i) => voiceLine("filler", "en", i));
    assert.equal(new Set(en).size, 3);
    assert.equal(voiceLine("filler", "en", 3), en[0]);
    assert.ok(voiceLine("filler", "ur", 1).length > 0);
    assert.match(voiceLine("fallback", "ur"), /معذرت/);
  });

  test("the greeting names the business, in its fixed language, and never a placeholder", () => {
    assert.deepEqual(buildVoiceGreeting({ businessName: "Nyron", replyLanguage: "en" }), {
      text: "Hello, thanks for calling Nyron. You're speaking with an AI assistant. How can I help you today?",
      language: "en",
      custom: false,
    });
    assert.equal(buildVoiceGreeting({ businessName: "this business", replyLanguage: "en" }).text, "Hello, thanks for calling. You're speaking with an AI assistant. How can I help you today?");
    // Older stored values ("auto", Italian) degrade to English; the interface language must not leak in (§7).
    for (const replyLanguage of ["auto", "it", undefined]) assert.equal(buildVoiceGreeting({ businessName: "X", replyLanguage, uiLocale: "ur" }).language, "en");
    assert.equal(buildVoiceGreeting({ businessName: "X", replyLanguage: "en", uiLocale: "ur" }).language, "en");
  });

  test("every fixed spoken line is voice-safe: no digits, markdown or URLs", () => {
    const lines = [
      buildVoiceGreeting({ businessName: "this business", replyLanguage: "en" }).text,
      buildVoiceGreeting({ businessName: "this business", replyLanguage: "ur" }).text,
      ...["filler", "fallback"].flatMap((kind) => ["en", "ur"].flatMap((lang) => [0, 1, 2].map((i) => voiceLine(kind, lang, i)))),
      ...Object.values(PREVIEW_TEXT),
    ];
    for (const line of lines) assert.doesNotMatch(line, /[\d*#_`[\]]|https?:/, line);
  });
});

describe("voice catalog", () => {
  test("ids are unique, and every voice is a speaker in a model we actually download", () => {
    assert.equal(new Set(VOICES.map((v) => v.id)).size, VOICES.length);
    for (const v of VOICES) {
      assert.ok(SPOKEN_LANGUAGES.includes(v.language), v.id);
      assert.ok(["female", "male"].includes(v.gender), v.id);
      if (v.engine === "piper") assert.ok(PIPER_VOICES[v.model], `${v.id}: no Piper model in models.js`);
      else assert.ok(KOKORO_MODEL.engineLanguage[v.language] !== undefined, `${v.id}: no Kokoro engine language`);
    }
  });

  test("every spoken language has a female AND a male voice, and a default that is its own language", () => {
    for (const lang of SPOKEN_LANGUAGES) {
      const genders = new Set(VOICES.filter((v) => v.language === lang).map((v) => v.gender));
      assert.deepEqual([...genders].sort(), ["female", "male"], lang);
      assert.equal(getVoice(DEFAULT_VOICES[lang]).language, lang);
    }
  });

  test("Kokoro speaker ids match the model's own table (kokoro-multi-lang-v1_0 metadata)", () => {
    const expected = { af_heart: 3, am_michael: 16, bf_emma: 21, bm_george: 26, hf_alpha: 31, hm_omega: 33 };
    for (const [name, sid] of Object.entries(expected)) assert.equal(getVoice(`kokoro:${name}`).speaker, sid, name);
  });

  test("voiceFor never returns a voice of the wrong language", () => {
    assert.equal(voiceFor({ ur: "kokoro:hm_psi" }, "ur").id, "kokoro:hm_psi");
    assert.equal(voiceFor({ ur: "kokoro:af_heart" }, "ur").id, DEFAULT_VOICES.ur);
    assert.equal(voiceFor({ en: "nope" }, "en").id, DEFAULT_VOICES.en);
    assert.equal(voiceFor(null, "fr").id, DEFAULT_VOICES.en);
  });

  test("agent-config validation accepts real voices for their language and nothing else", () => {
    assert.deepEqual(voiceSelectionProblems({ en: "kokoro:am_michael", ur: "kokoro:hf_beta" }), []);
    assert.deepEqual(voiceSelectionProblems({ ur: "kokoro:am_michael" }), ["voice:kokoro:am_michael"]);
    assert.deepEqual(voiceSelectionProblems({ fr: "kokoro:af_heart" }), ["language:fr"]);
    assert.deepEqual(voiceSelectionProblems([]), ["invalid"]);
  });
});

describe("speech-to-text routing", () => {
  const fakeEngine = {
    info: { stt: "parakeet" },
    recognizer: {
      createStream: () => ({ acceptWaveform() {} }),
      decodeAsync: async () => ({ text: " hello " }),
    },
  };

  test("every call understands Urdu: Groq whenever a key exists, whatever the reply language; local without one", () => {
    const stt = createSpeechToText({ engine: fakeEngine, env: { GROQ_API_KEY: "k" } });
    assert.equal(stt.forCall({ vocabulary: [] }).id, "groq:whisper-large-v3");
    assert.equal(stt.forCall().id, "groq:whisper-large-v3");
    assert.equal(stt.forCall({ replyLanguage: "en" }).id, "groq:whisper-large-v3", "an English business still has Urdu callers");
    const noKey = createSpeechToText({ engine: fakeEngine, env: {} });
    assert.equal(noKey.forCall().id, "parakeet");
    assert.equal(noKey.forCall().understandsUrdu, false);
    assert.equal(stt.forCall().understandsUrdu, true);
    const forcedLocal = createSpeechToText({ engine: fakeEngine, env: { GROQ_API_KEY: "k", VOICE_STT_PROVIDER: "local" } });
    assert.equal(forcedLocal.forCall().id, "parakeet");
    assert.throws(() => createSpeechToText({ engine: fakeEngine, env: { VOICE_STT_PROVIDER: "groq" } }), /GROQ_API_KEY/);
  });

  test("Groq Whisper: uploads a WAV with the language hint; on failure the local engine answers and says why", async () => {
    const seen = [];
    const ok = groqTranscriber({
      apiKey: "k",
      model: "whisper-large-v3",
      language: "ur",
      fallback: { transcribe: async () => ({ text: "local", ms: 1, engine: "parakeet" }) },
      fetchImpl: async (url, init) => {
        seen.push({ url, form: init.body, auth: init.headers.Authorization });
        return { ok: true, json: async () => ({ text: " السلام علیکم " }) };
      },
    });
    const result = await ok.transcribe(new Float32Array(1600));
    assert.equal(result.text, "السلام علیکم");
    assert.equal(seen[0].form.get("language"), "ur");
    assert.equal(seen[0].form.get("model"), "whisper-large-v3");
    assert.equal(seen[0].auth, "Bearer k");
    assert.equal(seen[0].form.get("file").size, 44 + 3200);

    const failing = groqTranscriber({
      apiKey: "k",
      model: "whisper-large-v3",
      fallback: { transcribe: async () => ({ text: "local text", ms: 1, engine: "parakeet" }) },
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    const fallback = await failing.transcribe(new Float32Array(160));
    assert.equal(fallback.text, "local text");
    assert.equal(fallback.engine, "parakeet");
    assert.match(fallback.fallbackReason, /503/);
  });

  test("Whisper writing short Urdu in Devanagari (Hindi) is asked again, once, with language=ur", async () => {
    const asked = [];
    const answers = ["हाँ जी", "ہاں جی"];
    const transcriber = groqTranscriber({
      apiKey: "k",
      model: "whisper-large-v3",
      fallback: { transcribe: async () => ({ text: "local", ms: 1, engine: "parakeet" }) },
      fetchImpl: async (url, init) => {
        asked.push(init.body.get("language"));
        return { ok: true, json: async () => ({ text: answers.shift() }) };
      },
    });
    const result = await transcriber.transcribe(new Float32Array(1600));
    assert.equal(result.text, "ہاں جی");
    assert.deepEqual(asked, [null, "ur"], "first with no language hint, then the retry");

    // Normal Urdu or English is never asked twice.
    asked.length = 0;
    answers.push("What are your opening hours?");
    await transcriber.transcribe(new Float32Array(1600));
    assert.deepEqual(asked, [null]);
  });

  test("every transcriber spells the business's name right, and Whisper is given it as its prompt", async () => {
    const local = createSpeechToText({ engine: { ...fakeEngine, recognizer: { ...fakeEngine.recognizer, decodeAsync: async () => ({ text: "Tell me about NIRON." }) } }, env: {} });
    const result = await local.forCall({ replyLanguage: "en", vocabulary: ["Nyron"] }).transcribe(new Float32Array(160));
    assert.equal(result.text, "Tell me about Nyron.");
    assert.deepEqual(result.corrections, ["NIRON→Nyron"]);
    assert.equal(result.engine, "parakeet");

    let form;
    const hosted = createSpeechToText({
      engine: fakeEngine,
      env: { GROQ_API_KEY: "k" },
      fetchImpl: async (url, init) => ((form = init.body), { ok: true, json: async () => ({ text: "What is Nairan?" }) }),
    });
    const whisper = await hosted.forCall({ vocabulary: ["Nyron"] }).transcribe(new Float32Array(160));
    assert.match(form.get("prompt"), /^Nyron\. /, "the business's name first, then the script primer");
    assert.match(form.get("prompt"), /السلام علیکم/, "an Urdu-script primer keeps short Urdu in Urdu script");
    assert.equal(form.get("language"), null, "Whisper is not told which language it hears: callers use either");
    assert.equal(whisper.text, "What is Nyron?");
  });

  test("encodeWav writes a valid 16-bit mono RIFF header", () => {
    const wav = encodeWav(new Float32Array(16000), 16000);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 32000);
    assert.equal(wav.length, 44 + 32000);
  });
});

describe("small utilities", () => {
  test("the serial queue runs tasks one at a time, in order, and survives a failure", async () => {
    const run = createSerialQueue();
    const order = [];
    const slow = (label, ms) => () => new Promise((r) => setTimeout(() => { order.push(label); r(label); }, ms));
    const results = await Promise.allSettled([
      run(slow("a", 20)),
      run(() => Promise.reject(new Error("boom"))),
      run(slow("b", 1)),
    ]);
    assert.deepEqual(order, ["a", "b"]);
    assert.equal(results[1].status, "rejected");
    assert.equal(results[2].value, "b");
  });

  test("median of response times", () => {
    assert.equal(median([]), null);
    assert.equal(median([900]), 900);
    assert.equal(median([1200, 800, 1000]), 1000);
    assert.equal(median([800, 1000, null, 1200, 1400]), 1100);
  });
});

describe("vocabulary — names the recogniser cannot know", () => {
  // The words one real call produced for "Nyron" (call 8a6db61d), plus Parakeet's own
  // spelling of clean synthetic speech.
  test("every way that call misheard the business's name is put right", () => {
    for (const [heard, meant] of [
      ["I want to learn more about Nairan, like its services, what is Nairan, etc.", "I want to learn more about Nyron, like its services, what is Nyron, etc."],
      ["Please tell me more about Niron.", "Please tell me more about Nyron."],
      ["Do you have any information about Nairawan?", "Do you have any information about Nyron?"],
      ["Tell me about NIRON and NYRON.", "Tell me about Nyron and Nyron."],
    ]) {
      assert.equal(correctTranscript(heard, ["Nyron"]).text, meant);
    }
    assert.deepEqual(correctTranscript("What is Nairan?", ["Nyron"]).corrections, ["Nairan→Nyron"]);
  });

  test("ordinary words are never rewritten into the name", () => {
    // Lower-case: the recogniser did not take it for a proper noun.
    assert.equal(correctTranscript("my neuron research", ["Nyron"]).text, "my neuron research");
    // A different sound.
    assert.equal(correctTranscript("Why Rw and Nidon?", ["Nyron"]).text, "Why Rw and Nidon?");
    // Sentence-initial words are capitalised anyway: only a near-identical spelling counts.
    assert.equal(correctTranscript("Small clinics. Nairan is it?", ["Smile", "Nyron"]).text, "Small clinics. Nairan is it?");
    assert.equal(correctTranscript("Small clinics. Niron is it?", ["Smile", "Nyron"]).text, "Small clinics. Nyron is it?");
    // Urdu script is never touched; no vocabulary, no change.
    assert.equal(correctTranscript("نائرن کے بارے میں بتائیں", ["Nyron"]).text, "نائرن کے بارے میں بتائیں");
    assert.deepEqual(correctTranscript("What is Nairan?", []), { text: "What is Nairan?", corrections: [] });
  });

  test("the vocabulary is the business's own name — never the placeholder, never a short word", () => {
    assert.deepEqual(callVocabulary({ businessName: "Nyron" }), ["Nyron"]);
    assert.deepEqual(callVocabulary({ businessName: "this business" }), []);
    assert.deepEqual(callVocabulary({ businessName: "Bright Smile Dental Co" }), ["Bright", "Smile", "Dental"]);
    assert.deepEqual(callVocabulary({}), []);
    assert.equal(soundKey("Nyron"), soundKey("Nairawan"));
    assert.equal(soundKey("ClinicHMS"), soundKey("Klinik HMS"));
  });
});

test("on a call the model is told its customer's words are a transcript; chat is not", () => {
  const config = { businessName: "Nyron", replyLanguage: "en", tone: "friendly" };
  const voice = buildSystemInstruction({ config, channel: "voice" });
  assert.match(voice, /HEARING: .*speech recognition.*\(Nyron\)/);
  assert.doesNotMatch(buildSystemInstruction({ config, channel: "chat" }), /HEARING:/);
  assert.match(buildSystemInstruction({ config: { ...config, businessName: "this business" }, channel: "voice" }), /business's name or like/);
});

// ── the phone edge (CLAUDE.md §6.24, §6.30): G.711 μ-law and 8 kHz ⇄ 16 kHz ─────────────────────────
import { mulawToFloat32, float32ToMulaw, resample, createUpsampler2 } from "@/lib/voice/audio";

describe("phone audio: μ-law", () => {
  const tone = (hz, rate, seconds = 1, amplitude = 0.5) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
  const peak = (samples, skip = 0) => samples.slice(skip, samples.length - skip).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  test("encodes silence as 0xFF and the loudest samples as 0x80 / 0x00 (the G.711 table)", () => {
    assert.deepEqual([...float32ToMulaw(new Float32Array(3))], [0xff, 0xff, 0xff]);
    assert.deepEqual([...float32ToMulaw(Float32Array.of(1, -1))], [0x80, 0x00]);
  });

  test("a round trip stays within μ-law's own precision, and louder than full scale is clipped, not wrapped", () => {
    const original = tone(440, 8000, 1, 0.6);
    const back = mulawToFloat32(float32ToMulaw(original));
    let worst = 0;
    for (let i = 0; i < original.length; i++) worst = Math.max(worst, Math.abs(original[i] - back[i]));
    assert.ok(worst < 0.02, `worst error ${worst}`);
    assert.ok(mulawToFloat32(float32ToMulaw(Float32Array.of(5, -5))).every((v, i) => (i === 0 ? v > 0.9 : v < -0.9)));
  });

  test("every one of the 256 bytes decodes, and re-encodes to itself (except the two zero codes)", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const again = float32ToMulaw(mulawToFloat32(all));
    for (let i = 0; i < 256; i++) if (i !== 0x7f) assert.equal(again[i], i, `byte ${i}`);
  });
});

describe("phone audio: resampling", () => {
  const tone = (hz, rate, seconds = 1) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
  const peak = (samples, skip = 300) => samples.slice(skip, samples.length - skip).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  test("the length follows the rates; the same rate is returned untouched", () => {
    assert.equal(resample(new Float32Array(24000), 24000, 8000).length, 8000);
    assert.equal(resample(new Float32Array(22050), 22050, 8000).length, 8000);
    const same = new Float32Array(10);
    assert.equal(resample(same, 8000, 8000), same);
  });

  test("a voice-range tone keeps its level going down to 8 kHz", () => {
    assert.ok(Math.abs(peak(resample(tone(1000, 24000), 24000, 8000)) - 0.5) < 0.02);
  });

  test("a tone above the phone's band is removed, not folded back into the voice", () => {
    // 6 kHz does not exist at 8 kHz sampling (Nyquist 4 kHz): plain decimation would alias it to 2 kHz.
    assert.ok(peak(resample(tone(6000, 24000), 24000, 8000)) < 0.01);
  });

  test("the streaming up-sampler gives the same wave as the ideal one, whatever the frame size", () => {
    const input = tone(1000, 8000);
    for (const frame of [160, 37, 1]) {
      const up = createUpsampler2();
      const parts = [];
      for (let i = 0; i < input.length; i += frame) parts.push(up.push(input.subarray(i, i + frame)));
      const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) (out.set(p, at), (at += p.length));
      let worst = 0;
      for (let i = 100; i < out.length - 100; i++) worst = Math.max(worst, Math.abs(out[i] - 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 16000)));
      assert.ok(worst < 0.01, `frame ${frame}: worst ${worst}`);
    }
  });
});
