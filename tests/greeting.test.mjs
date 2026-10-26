import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildGreeting, defaultGreeting, fillGreeting, greetingNotices, greetingProblems, normalizeGreeting, MAX_GREETING_CHARS } from "@/lib/voice/greeting";
import { buildVoiceGreeting } from "@/lib/agent/prompt";

// The call's opening line, per agent (CLAUDE.md §6.24, lib/voice/greeting.js): the built-in
// greeting's AI and recording notices, the owner's own text, and the console's warnings.

describe("the built-in greeting", () => {
  test("tells the caller it is an AI assistant; recording only while recording is on", () => {
    const off = defaultGreeting({ language: "en", businessName: "Pizza Roma" });
    assert.equal(off, "Hello, thanks for calling Pizza Roma. You're speaking with an AI assistant. How can I help you today?");
    assert.doesNotMatch(off, /record/i);
    const on = defaultGreeting({ language: "en", businessName: "Pizza Roma", recordCalls: true });
    assert.equal(on, "Hello, thanks for calling Pizza Roma. You're speaking with an AI assistant, and this call is being recorded. How can I help you today?");
  });

  test("Urdu: same notices, 'AI' in Urdu script, the verb agrees with the voice", () => {
    const off = defaultGreeting({ language: "ur", businessName: "Nyron", gender: "male" });
    assert.match(off, /آپ ایک اے آئی اسسٹنٹ سے بات کر رہے ہیں۔/);
    assert.doesNotMatch(off, /ریکارڈ/);
    assert.match(off, /سکتا ہوں؟$/);
    assert.match(defaultGreeting({ language: "ur", businessName: "Nyron", recordCalls: true }), /، اور یہ کال ریکارڈ کی جا رہی ہے۔ .*سکتی ہوں؟$/);
  });

  test("a placeholder business name is never spoken", () => {
    assert.equal(buildVoiceGreeting({ businessName: "this business", replyLanguage: "en" }).text, "Hello, thanks for calling. You're speaking with an AI assistant. How can I help you today?");
  });
});

describe("the owner's own greeting", () => {
  test("spoken exactly as written, in the reply language, with {business} filled in", () => {
    const config = { businessName: "Pizza Roma", replyLanguage: "en", recordCalls: true, greeting: { en: "Ciao! Welcome to {business}. What can I get you?", ur: "خوش آمدید" } };
    assert.deepEqual(buildGreeting(config), { text: "Ciao! Welcome to Pizza Roma. What can I get you?", language: "en", custom: true });
    assert.deepEqual(buildGreeting({ ...config, replyLanguage: "ur" }), { text: "خوش آمدید", language: "ur", custom: true });
    // Nothing is added behind the owner's back, even with recording on and no notice in it.
    assert.doesNotMatch(buildGreeting(config).text, /AI|record/);
  });

  test("an empty box for the reply language falls back to the built-in greeting", () => {
    const config = { businessName: "Pizza Roma", replyLanguage: "ur", greeting: { en: "Hi from {business}" } };
    const spoken = buildGreeting(config);
    assert.equal(spoken.custom, false);
    assert.match(spoken.text, /اے آئی/);
  });

  test("{business} with no name is dropped tidily", () => {
    assert.equal(fillGreeting("Thanks for calling {business}. How can I help?", null), "Thanks for calling. How can I help?");
  });

  test("stored values are cleaned on read, never thrown on", () => {
    assert.deepEqual(normalizeGreeting({ en: "  Hi  there ", ur: "", it: "Ciao", extra: 4 }), { en: "Hi there" });
    for (const bad of [null, "text", [], 7]) assert.deepEqual(normalizeGreeting(bad), {});
  });

  test("refused on save only when it cannot be spoken as meant", () => {
    assert.deepEqual(greetingProblems({ en: "Hello from {business}", ur: "" }), []);
    assert.deepEqual(greetingProblems({ en: null }), []);
    assert.deepEqual(greetingProblems("hello").map((p) => p.code), ["invalid"]);
    assert.deepEqual(greetingProblems({ it: "Ciao" }).map((p) => p.code), ["unknownLanguage"]);
    assert.deepEqual(greetingProblems({ en: 5 }).map((p) => p.code), ["invalid"]);
    assert.deepEqual(greetingProblems({ en: "x".repeat(MAX_GREETING_CHARS + 1) }).map((p) => p.code), ["tooLong"]);
    // Anything in braces but {business} would be read out literally.
    assert.deepEqual(greetingProblems({ en: "Hi, this is {agent} at {business}" }).map((p) => [p.code, p.vars.value]), [["unknownPlaceholder", "{agent}"]]);
    // Leaving out the notices is NOT a refusal — the owner decides.
    assert.deepEqual(greetingProblems({ en: "Welcome!" }), []);
  });
});

describe("the console's warnings", () => {
  test("no AI notice → warned; the built-in greeting (empty box) needs none", () => {
    assert.deepEqual(greetingNotices({ text: "Welcome to Pizza Roma!", recordCalls: false }), ["noAiNotice"]);
    assert.deepEqual(greetingNotices({ text: "Welcome! I'm the virtual assistant.", recordCalls: false }), []);
    assert.deepEqual(greetingNotices({ text: "", recordCalls: true }), []);
  });

  test("recording on and not mentioned → warned; recording off but mentioned → warned", () => {
    assert.deepEqual(greetingNotices({ text: "Hi, you're talking to our AI.", recordCalls: true }), ["noRecordingNotice"]);
    assert.deepEqual(greetingNotices({ text: "Hi, our AI here. This call is recorded.", recordCalls: true }), []);
    assert.deepEqual(greetingNotices({ text: "Hi, our AI here. This call is recorded.", recordCalls: false }), ["recordingWhileOff"]);
  });

  test("Urdu and Roman Urdu greetings are read in their own words", () => {
    assert.deepEqual(greetingNotices({ text: "السلام علیکم، آپ اے آئی اسسٹنٹ سے بات کر رہے ہیں۔ یہ کال ریکارڈ کی جا رہی ہے۔", recordCalls: true }), []);
    assert.deepEqual(greetingNotices({ text: "السلام علیکم، خوش آمدید", recordCalls: true }), ["noAiNotice", "noRecordingNotice"]);
    assert.deepEqual(greetingNotices({ text: "Assalam o alaikum, aap AI assistant se baat kar rahe hain", recordCalls: false }), []);
  });
});
