import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { groqTranscriber } from "@/lib/voice/speech/stt";
import { callPhrase, callVocabulary, correctTranscript } from "@/lib/voice/vocabulary";

/**
 * WHAT THE RECOGNISER HEARD, AND WHICH LANGUAGE IT THOUGHT IT WAS (CLAUDE.md §6.24).
 *
 * Whisper is not told the caller's language (a fixed hint forces the other language into the wrong one), so on a short or
 * clipped utterance it sometimes decides on one nobody speaks to this agent. Measured with the real recogniser on
 * half-second Urdu fragments: it answered as Arabic and as Portuguese ("جی میرا نمبر" → "Dimi,"). A real call came back as
 * Russian ("No, nothing" → "Нет, ничего"). Asking again with English and with Urdu and keeping the answer it was more sure
 * of repaired most of them.
 */

const local = { transcribe: async () => ({ text: "local", ms: 1, engine: "parakeet" }) };

/** A fake Groq: answers by language hint (null = no hint), records every request. */
function groq(byHint, { status = 200, headers = {} } = {}) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const hint = init.body.get("language");
    asked.push(hint);
    const answer = typeof byHint === "function" ? byHint(hint, asked.length) : byHint[hint ?? "none"];
    if (answer?.status) return { ok: false, status: answer.status, headers: { get: (k) => (answer.headers ?? {})[k.toLowerCase()] ?? null } };
    return { ok: status === 200, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => answer };
  };
  return { asked, transcriber: groqTranscriber({ apiKey: "k", model: "whisper-large-v3", fallback: local, fetchImpl }) };
}
const verbose = (text, language, avgLogprob = -0.3) => ({ text, language, segments: [{ avg_logprob: avgLogprob }] });

describe("a language nobody speaks to this agent is asked again", () => {
  test("Portuguese for a short Urdu fragment: asked again in English and in Urdu, the answer it was surer of wins", async () => {
    const { asked, transcriber } = groq({
      none: verbose(" Dimi,", "Portuguese", -0.58),
      en: verbose(" Jee Miri.", "English", -1.03),
      ur: verbose(" جی میٹ", "Urdu", -0.09),
    });
    const result = await transcriber.transcribe(new Float32Array(8000));
    assert.equal(result.text, "جی میٹ");
    assert.equal(asked[0], null, "first with no language hint");
    assert.deepEqual(asked.slice(1).sort(), ["en", "ur"], "then English and Urdu");
    assert.equal(result.relanguaged, "Portuguese→ur");
  });

  test("the English reading wins when the recogniser is surer of it", async () => {
    const { transcriber } = groq({
      none: verbose(" Нет, ничего.", "Russian", -0.7),
      en: verbose(" No, nothing.", "English", -0.2),
      ur: verbose(" نہ نتھنگ", "Urdu", -0.9),
    });
    const result = await transcriber.transcribe(new Float32Array(8000));
    assert.equal(result.text, "No, nothing.");
    assert.equal(result.relanguaged, "Russian→en");
  });

  test("Arabic counts too (it writes Urdu with Arabic letters: نهين)", async () => {
    const { asked, transcriber } = groq({ none: verbose(" نهين بيوت.", "Arabic", -0.75), en: verbose(" Nahin.", "English", -0.47), ur: verbose(" نہ ہیم", "Urdu", -0.4) });
    const result = await transcriber.transcribe(new Float32Array(8000));
    assert.equal(asked.length, 3);
    assert.equal(result.text, "نہ ہیم");
  });

  test("English and Urdu are never asked twice, whatever the capitalisation", async () => {
    for (const language of ["English", "english", "Urdu", "urdu"]) {
      const { asked, transcriber } = groq({ none: verbose("Hello there", language) });
      const result = await transcriber.transcribe(new Float32Array(8000));
      assert.equal(asked.length, 1, language);
      assert.equal(result.relanguaged, undefined);
    }
  });

  test("a reply with no language in it (or no segments) is taken as it is", async () => {
    const { asked, transcriber } = groq({ none: { text: " Hello" } });
    assert.equal((await transcriber.transcribe(new Float32Array(800))).text, "Hello");
    assert.equal(asked.length, 1);
    const unsure = groq({ none: { text: " Bonjour", language: "French" }, en: { text: " Bonjour", language: "English" }, ur: { text: " بون جور", language: "Urdu" } });
    const result = await unsure.transcriber.transcribe(new Float32Array(800));
    assert.equal(unsure.asked.length, 3, "still asked again; with no confidence to compare, the first retry (English) is kept");
    assert.equal(result.text, "Bonjour");
  });

  test("a caller who set a language on purpose is never second-guessed", async () => {
    const asked = [];
    const t = groqTranscriber({
      apiKey: "k",
      model: "whisper-large-v3",
      language: "ur",
      fallback: local,
      fetchImpl: async (url, init) => (asked.push(init.body.get("language")), { ok: true, json: async () => verbose(" Dimi", "Portuguese") }),
    });
    await t.transcribe(new Float32Array(800));
    assert.deepEqual(asked, ["ur"]);
  });

  test("Devanagari is still asked again as Urdu — once — and that is not also a language retry", async () => {
    const { asked, transcriber } = groq((hint) => (hint === "ur" ? verbose(" ہاں جی", "Urdu") : verbose(" हाँ जी", "Hindi")));
    const result = await transcriber.transcribe(new Float32Array(800));
    assert.equal(result.text, "ہاں جی");
    assert.deepEqual(asked, [null, "ur"]);
  });

  test("a failed retry keeps the first answer rather than losing the utterance", async () => {
    const { transcriber } = groq({ none: verbose(" Dimi,", "Portuguese", -0.5), en: { status: 500 }, ur: { status: 500 } });
    const result = await transcriber.transcribe(new Float32Array(800));
    assert.equal(result.text, "Dimi,", "the unreadable-script check and the session decide what to do with it");
    assert.equal(result.fallbackReason, undefined, "the hosted engine did answer");
  });
});

describe("a rate limit is waited out once, briefly, before falling back to the local engine", () => {
  test("429 with a short Retry-After: asked again after waiting, and the hosted answer is used", async () => {
    let calls = 0;
    const waited = [];
    const t = groqTranscriber({
      apiKey: "k",
      model: "whisper-large-v3",
      fallback: local,
      sleep: async (ms) => waited.push(ms),
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? { ok: false, status: 429, headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "1" : null) } }
          : { ok: true, json: async () => verbose(" What are your hours?", "English") };
      },
    });
    const result = await t.transcribe(new Float32Array(800));
    assert.equal(result.text, "What are your hours?");
    assert.equal(result.engine, "groq:whisper-large-v3");
    assert.deepEqual(waited, [1000]);
    assert.equal(calls, 2);
  });

  test("a long Retry-After is not waited for: the local engine answers at once", async () => {
    let calls = 0;
    const t = groqTranscriber({
      apiKey: "k",
      model: "whisper-large-v3",
      fallback: local,
      sleep: async () => assert.fail("must not wait"),
      fetchImpl: async () => (calls++, { ok: false, status: 429, headers: { get: () => "30" } }),
    });
    const result = await t.transcribe(new Float32Array(800));
    assert.equal(result.engine, "parakeet");
    assert.match(result.fallbackReason, /429/);
    assert.equal(calls, 1);
  });

  test("still limited on the second try: the local engine answers, after one wait only", async () => {
    let calls = 0;
    const waited = [];
    const t = groqTranscriber({
      apiKey: "k",
      model: "whisper-large-v3",
      fallback: local,
      sleep: async (ms) => waited.push(ms),
      fetchImpl: async () => (calls++, { ok: false, status: 429, headers: { get: () => "1" } }),
    });
    const result = await t.transcribe(new Float32Array(800));
    assert.equal(calls, 2);
    assert.deepEqual(waited, [1000]);
    assert.equal(result.engine, "parakeet");
  });

  test("a 429 with no Retry-After header waits a short default; other errors are not retried", async () => {
    const waited = [];
    let calls = 0;
    const t = groqTranscriber({ apiKey: "k", model: "m", fallback: local, sleep: async (ms) => waited.push(ms), fetchImpl: async () => (calls++, { ok: false, status: 429, headers: { get: () => null } }) });
    await t.transcribe(new Float32Array(800));
    assert.deepEqual(waited, [800]);
    calls = 0;
    const server = groqTranscriber({ apiKey: "k", model: "m", fallback: local, sleep: async () => assert.fail("no wait"), fetchImpl: async () => (calls++, { ok: false, status: 503, headers: { get: () => null } }) });
    await server.transcribe(new Float32Array(800));
    assert.equal(calls, 1);
  });
});

describe("a short business name is not lost (real calls heard KO Restaurants as Kew restaurants and Cave Resturants)", () => {
  const config = { businessName: "KO Restaurants" };
  const vocab = callVocabulary(config);
  const phrase = callPhrase(config);

  test("the whole name is kept for the recogniser; the two-letter word alone is never corrected", () => {
    assert.equal(phrase, "KO Restaurants");
    assert.deepEqual(vocab, ["Restaurants"]);
    assert.equal(correctTranscript("Do you have a Kew garden", vocab, { phrase }).text, "Do you have a Kew garden");
  });

  test("a sound-alike of the short word right before the long one is put right", () => {
    for (const [heard, meant] of [
      ["Hey, Kew restaurants.", "Hey, KO Restaurants."],
      ["Hello, Cave Resturants. What do you do?", "Hello, KO Restaurants. What do you do?"],
      ["Kew Restaurants", "KO Restaurants"],
      ["Welcome to Cow Restaurants!", "Welcome to KO Restaurants!"],
      ["Hello Kew restaurants and Kew restaurants", "Hello KO Restaurants and KO Restaurants"],
    ]) assert.equal(correctTranscript(heard, vocab, { phrase }).text, meant, heard);
  });

  test("the correction is logged like any other", () => {
    assert.deepEqual(correctTranscript("Hey, Kew restaurants.", vocab, { phrase }).corrections, ["Kew restaurants→KO Restaurants"]);
  });

  test("it only happens right next to the long word — an ordinary sentence is left alone", () => {
    for (const text of [
      "Do you have a cow farm?",
      "I want a table at the restaurants near the Kew gardens",
      "Kew is a place in London",
      "The restaurants here are great",
      "hello cave restaurants", // not capitalised: the recogniser did not take it for a name
      "Kew and then restaurants",
      "Do you cater at my ko company",
      "Kitchen Restaurants", // too long to stand in for KO
      "Cowhouse Restaurants", // sounds like "K" too, but is eight letters: a word of its own, not a mishearing of two
    ]) assert.equal(correctTranscript(text, vocab, { phrase }).text, text, text);
  });

  test("a name that was already right stays as it is (and is not logged)", () => {
    const right = correctTranscript("Thanks for calling KO Restaurants", vocab, { phrase });
    assert.equal(right.text, "Thanks for calling KO Restaurants");
    assert.deepEqual(right.corrections, []);
    assert.deepEqual(correctTranscript("thanks for calling ko restaurants", vocab, { phrase }).corrections, []);
  });

  test("a name with only long words has no phrase and works as before", () => {
    const nyron = { businessName: "Nyron Software Solutions" };
    assert.equal(callPhrase(nyron), null);
    assert.equal(correctTranscript("Tell me about NIRON.", callVocabulary(nyron), { phrase: callPhrase(nyron) }).text, "Tell me about Nyron.");
  });

  test("no name, the placeholder, or only short words give no phrase", () => {
    assert.equal(callPhrase({ businessName: "" }), null);
    assert.equal(callPhrase({}), null);
    assert.equal(callPhrase({ businessName: "this business" }), null);
    assert.equal(callPhrase({ businessName: "AB Co" }), null);
    assert.equal(correctTranscript("Hello Abe Cow", [], { phrase: null }).text, "Hello Abe Cow");
  });

  test("Whisper is given the whole name as the start of its spelling prompt", async () => {
    let prompt;
    const t = groqTranscriber({
      apiKey: "k",
      model: "m",
      vocabulary: vocab,
      phrase,
      fallback: local,
      fetchImpl: async (url, init) => ((prompt = init.body.get("prompt")), { ok: true, json: async () => verbose("Hello", "English") }),
    });
    await t.transcribe(new Float32Array(800));
    assert.match(prompt, /^KO Restaurants\. Restaurants\. /);
  });
});
