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

  test("asking for a person, in English and Italian", () => {
    for (const text of ["Can I speak to a human please", "put me through to an operator", "Vorrei parlare con un operatore", "posso parlare con una persona?"]) {
      const result = classifyTurn({ callerText: text, sources: ["x"] });
      assert.equal(result.intent, INTENTS.HUMAN_REQUEST, text);
      assert.equal(result.outcome, OUTCOMES.HANDOFF_REQUESTED, text);
    }
  });

  test("small talk is conversational, never 'no knowledge'", () => {
    assert.equal(classifyTurn({ callerText: "Hello!" }).intent, INTENTS.GREETING);
    assert.equal(classifyTurn({ callerText: "Buongiorno" }).intent, INTENTS.GREETING);
    assert.equal(classifyTurn({ callerText: "thanks" }).intent, INTENTS.ACKNOWLEDGEMENT);
    assert.equal(classifyTurn({ callerText: "Okay, goodbye" }).intent, INTENTS.GOODBYE);
    assert.equal(classifyTurn({ callerText: "grazie, arrivederci" }).intent, INTENTS.GOODBYE);
    for (const text of ["Hello!", "thanks", "goodbye"]) {
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
    assert.deepEqual(verifier.verify(ticket), { ok: true, tenantId: "clinic-1" });
    assert.deepEqual(verifier.verify(ticket), { ok: false, reason: "replayed" });
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
  test("a fixed reply language always wins", () => {
    assert.equal(chooseSpokenLanguage({ replyLanguage: "it", text: "The price is 149 euro." }), "it");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "en", text: "Il prezzo è di 149 euro." }), "en");
  });

  test("'auto' follows the sentence, and sticks when a sentence carries no evidence", () => {
    assert.equal(chooseSpokenLanguage({ replyLanguage: "auto", text: "Il piano Pro costa 149 euro al mese." }), "it");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "auto", text: "The Pro plan is 149 euro a month." }), "en");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "auto", text: "Pro: 149 euro.", previous: "it" }), "it");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "auto", text: "Pro: 149 euro." }), "en");
  });

  test("detectSearchConfig is unchanged by the stopWordCounts extraction", () => {
    assert.equal(detectSearchConfig("Il nostro studio è aperto dal lunedì al venerdì, e per le urgenze siamo sempre disponibili con il servizio della clinica."), "italian");
    assert.equal(detectSearchConfig("Our clinic is open from Monday to Friday and we are always available for the emergencies of our patients."), "english");
  });

  test("Urdu is recognised by its script under 'auto'; a fixed 'ur' always speaks Urdu", () => {
    assert.equal(chooseSpokenLanguage({ replyLanguage: "auto", text: "ہمارے سپورٹ کے اوقات پیر سے جمعہ ہیں۔" }), "ur");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "auto", text: "پرو پلان 149 یورو ہے۔" }), "ur");
    assert.equal(chooseSpokenLanguage({ replyLanguage: "ur", text: "The price is 149 euro." }), "ur");
    // A brand name inside Urdu does not flip it to English.
    assert.equal(chooseSpokenLanguage({ replyLanguage: "auto", text: "StorePulse کا پرو پلان بہترین ہے۔" }), "ur");
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

  test("on a call the model is told its voice's gender — only on voice, and per language when they differ", () => {
    const base = { businessName: "Nyron", tone: "professional", purpose: "", hours: null, capabilities: {}, timezone: "UTC" };
    const voiceIt = buildSystemInstruction({ config: { ...base, replyLanguage: "it", voices: { it: "kokoro:im_nicola" } }, channel: "voice" });
    assert.match(voiceIt, /VOICE: Your voice on this call is male\. .*masculine forms/);
    const chat = buildSystemInstruction({ config: { ...base, replyLanguage: "it", voices: {} }, channel: "chat" });
    assert.doesNotMatch(chat, /VOICE:/);
    const mixed = buildSystemInstruction({ config: { ...base, replyLanguage: "auto", voices: { ur: "kokoro:hm_omega" } }, channel: "voice" });
    assert.match(mixed, /female in English, female in Italian, male in Urdu/);
    assert.match(mixed, /Urdu script, never in Roman/);
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
      text: "Hello, thanks for calling Nyron. How can I help you today?",
      language: "en",
    });
    assert.match(buildVoiceGreeting({ businessName: "Nyron", replyLanguage: "it" }).text, /^Buongiorno, grazie per aver chiamato Nyron\./);
    assert.equal(buildVoiceGreeting({ businessName: "this business", replyLanguage: "auto" }).text, "Hello, thanks for calling. How can I help you today?");
    // "auto" has no caller to mirror yet; the interface language must not leak in (§7).
    assert.equal(buildVoiceGreeting({ businessName: "X", replyLanguage: "auto", uiLocale: "it" }).language, "en");
  });

  test("every fixed spoken line is voice-safe: no digits, markdown or URLs", () => {
    const lines = [
      buildVoiceGreeting({ businessName: "this business", replyLanguage: "en" }).text,
      buildVoiceGreeting({ businessName: "this business", replyLanguage: "it" }).text,
      buildVoiceGreeting({ businessName: "this business", replyLanguage: "ur" }).text,
      ...["filler", "fallback"].flatMap((kind) => ["en", "it", "ur"].flatMap((lang) => [0, 1, 2].map((i) => voiceLine(kind, lang, i)))),
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
    const expected = { af_heart: 3, am_michael: 16, bf_emma: 21, bm_george: 26, if_sara: 35, im_nicola: 36, hf_alpha: 31, hm_omega: 33 };
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

  test("auto: Urdu-capable calls go to Groq when a key exists; English/Italian calls stay local", () => {
    const stt = createSpeechToText({ engine: fakeEngine, env: { GROQ_API_KEY: "k" } });
    assert.equal(stt.forCall({ replyLanguage: "ur" }).id, "groq:whisper-large-v3");
    assert.equal(stt.forCall({ replyLanguage: "auto" }).id, "groq:whisper-large-v3");
    assert.equal(stt.forCall({ replyLanguage: "en" }).id, "parakeet");
    const noKey = createSpeechToText({ engine: fakeEngine, env: {} });
    assert.equal(noKey.forCall({ replyLanguage: "ur" }).id, "parakeet");
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
    const whisper = await hosted.forCall({ replyLanguage: "auto", vocabulary: ["Nyron"] }).transcribe(new Float32Array(160));
    assert.equal(form.get("prompt"), "Nyron");
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
