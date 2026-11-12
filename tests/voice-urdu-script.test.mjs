import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { devanagariToUrdu, hasDevanagari, repairUrduScript } from "@/lib/voice/urdu-script";
import { createTextToSpeech } from "@/lib/voice/speech/tts";

/**
 * A stray Devanagari letter makes the Urdu voice say the word "Hindi" (measured with the real voice and Whisper, 4 of 4
 * sentences — CLAUDE.md §6.24), so it is written in Urdu script before the voice sees it.
 */
describe("Devanagari → Urdu script, for the voice", () => {
  test("text without Devanagari is returned untouched (the same string)", () => {
    for (const s of ["ہم کراچی میں ایک ریسٹورنٹ چلاتے ہیں۔", "We open at nine.", "Nyron کو کال کرنے کا شکریہ 0300 1234567", "", "   "]) {
      assert.equal(devanagariToUrdu(s), s);
      assert.equal(hasDevanagari(s), false);
    }
    assert.equal(devanagariToUrdu(null), "");
    assert.equal(devanagariToUrdu(undefined), "");
  });

  test("the glitches that were measured come out as the intended Urdu words", () => {
    assert.equal(devanagariToUrdu("ہم کراچی میں ایک ریسٹورنٹ چلाتے ہیں۔"), "ہم کراچی میں ایک ریسٹورنٹ چلاتے ہیں۔");
    assert.equal(devanagariToUrdu("ہمارا ڈیلیوری کا वقت پینتالیس منٹ ہے۔"), "ہمارا ڈیلیوری کا وقت پینتالیس منٹ ہے۔");
    assert.equal(devanagariToUrdu("جمعہ کو ہم दوپہر دو بجے کھلتے ہیں۔"), "جمعہ کو ہم دوپہر دو بجے کھلتے ہیں۔");
    assert.equal(devanagariToUrdu("کیا آپ اپنا نام اور فون نمبر بتा سکتے ہیں؟"), "کیا آپ اپنا نام اور فون نمبر بتا سکتے ہیں؟");
  });

  test("a whole Hindi word is written as the sound it makes", () => {
    assert.equal(devanagariToUrdu("बता"), "بتا");
    assert.equal(devanagariToUrdu("कीमत"), "کیمت", "close, not perfect: the vowel sign becomes ی and the rest follows");
    assert.equal(devanagariToUrdu("शुक्रिया"), "شکریا");
    assert.equal(devanagariToUrdu("नमस्ते"), "نمستے");
    assert.equal(devanagariToUrdu("आप"), "آپ");
  });

  test("dotted letters and nasal signs", () => {
    assert.equal(devanagariToUrdu("क़ीमत"), "قیمت", "ka + nukta is qaf");
    assert.equal(devanagariToUrdu("क़"), "ق", "the precomposed letter too");
    assert.equal(devanagariToUrdu("ज़रूर"), "زرور");
    assert.equal(devanagariToUrdu("हाँ"), "ہاں");
    assert.equal(devanagariToUrdu("कहाँ"), "کہاں");
  });

  test("digits and the full stop become the Urdu ones; Latin and Urdu around them are kept", () => {
    assert.equal(devanagariToUrdu("३०० रुपये।"), "۳۰۰ رپیے۔");
    assert.equal(devanagariToUrdu("०१२३४५६७८९"), "۰۱۲۳۴۵۶۷۸۹");
    assert.equal(devanagariToUrdu("Nyron का price"), "Nyron کا price");
    assert.equal(devanagariToUrdu("ہاں।"), "ہاں۔");
  });

  test("nothing Devanagari survives, whatever the input", () => {
    const everything = Array.from({ length: 0x80 }, (_, i) => String.fromCharCode(0x0900 + i)).join(" ");
    const out = devanagariToUrdu(everything);
    assert.equal(hasDevanagari(out), false, "every code point of the block is converted or dropped");
  });

  test("repairUrduScript is the entry the voice uses", () => {
    assert.equal(repairUrduScript("ہم वقت"), "ہم وقت");
  });
});

describe("the Urdu voice never receives Devanagari (speech/tts.js)", () => {
  /** A TTS over a fake engine that records the text it was asked to speak. */
  function ttsOver() {
    const spoken = [];
    const engine = {
      installedVoices: ["kokoro:hf_alpha", "kokoro:af_heart"],
      sampleRateFor: () => 24000,
      ttsEngine: async () => ({
        generateAsync: async ({ text }) => {
          spoken.push(text);
          return { samples: new Float32Array(2400).fill(0.2), sampleRate: 24000 };
        },
        sampleRate: 24000,
      }),
    };
    return { engine, spoken };
  }

  test("the engine is never handed Devanagari for an Urdu voice, and the result says it was repaired", async () => {
    const { engine, spoken } = ttsOver();
    const tts = createTextToSpeech({ engine });
    const result = await tts.synthesize({ text: "ہمارا वقت", voiceId: "kokoro:hf_alpha", language: "ur", pauseMs: 0 });
    assert.deepEqual(spoken, ["ہمارا وقت"]);
    assert.equal(result.repaired, true);
  });

  test("a clean Urdu sentence is passed through and not marked repaired", async () => {
    const { engine, spoken } = ttsOver();
    const tts = createTextToSpeech({ engine });
    const result = await tts.synthesize({ text: "ہمارا وقت", voiceId: "kokoro:hf_alpha", language: "ur", pauseMs: 0 });
    assert.deepEqual(spoken, ["ہمارا وقت"]);
    assert.equal(result.repaired, undefined);
  });

  test("it also works through the cache (a fixed line), and the cache key is the repaired text", async () => {
    const { engine, spoken } = ttsOver();
    const tts = createTextToSpeech({ engine });
    const a = await tts.synthesize({ text: "ہمارا वقت", voiceId: "kokoro:hf_alpha", language: "ur", cache: true, pauseMs: 0 });
    const b = await tts.synthesize({ text: "ہمارا وقت", voiceId: "kokoro:hf_alpha", language: "ur", cache: true, pauseMs: 0 });
    assert.equal(spoken.length, 1, "the repaired and the clean sentence are one cache entry");
    assert.equal(a.repaired, true);
    assert.equal(b.repaired, undefined, "the clean request was not repaired");
    assert.equal(b.cached, true);
  });

  test("an English voice is left alone, whatever the text (it is not the Urdu voice's problem)", async () => {
    const { engine, spoken } = ttsOver();
    const tts = createTextToSpeech({ engine });
    const result = await tts.synthesize({ text: "Hello वقت", voiceId: "kokoro:af_heart", language: "en", pauseMs: 0 });
    assert.deepEqual(spoken, ["Hello वقت"]);
    assert.equal(result.repaired, undefined);
  });
});
