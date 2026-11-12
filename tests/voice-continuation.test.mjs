import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { collapseRepeats, looksUnfinished, unreadableScript } from "@/lib/voice/transcript-clean";

describe("collapseRepeats", () => {
  test("a sentence written twice in a row is kept once", () => {
    assert.deepEqual(collapseRepeats("Yes, book it now. Yes, book it now."), { text: "Yes, book it now.", collapsed: true });
    assert.equal(collapseRepeats("Yes I have phone number which is 0340 5216542. Yes I have phone number which is 0340 5216542.").collapsed, true);
  });

  test("a whole utterance written twice with no punctuation between is kept once", () => {
    assert.equal(collapseRepeats("book me an appointment for monday book me an appointment for monday").text, "book me an appointment for monday");
    assert.equal(collapseRepeats("Yes, book it now Yes, book it now").collapsed, true);
  });

  test("three copies collapse to one", () => {
    assert.equal(collapseRepeats("Thank you very much. Thank you very much. Thank you very much.").text, "Thank you very much.");
  });

  test("Urdu repeats collapse too", () => {
    assert.equal(collapseRepeats("جی ہاں بک کر دیں۔ جی ہاں بک کر دیں۔").text, "جی ہاں بک کر دیں۔");
  });

  test("things people really say twice are left alone", () => {
    for (const text of ["No, no, no.", "very very good", "Yes, yes.", "Hello hello", "I want two, two tickets", "Monday, then Monday again works"]) {
      assert.deepEqual(collapseRepeats(text), { text, collapsed: false }, text);
    }
  });

  test("different sentences and empty input are untouched", () => {
    const text = "What are your hours? And do you open on Sundays?";
    assert.deepEqual(collapseRepeats(text), { text, collapsed: false });
    assert.deepEqual(collapseRepeats(""), { text: "", collapsed: false });
    assert.deepEqual(collapseRepeats(null), { text: "", collapsed: false });
  });
});

describe("looksUnfinished", () => {
  test("a joining word or a comma at the end means the caller has not finished", () => {
    for (const text of [
      "I want to book an appointment with",
      "I'd like to know the price of the",
      "I want to book an appointment,",
      "I need to speak to someone about my order and",
      "Hello, I want to...",
      "مجھے ایک اپائنٹمنٹ چاہیے اور",
      "میں ڈاکٹر کے ساتھ",
      "mujhe appointment chahiye aur",
      "I want",
    ]) {
      assert.equal(looksUnfinished(text), true, text);
    }
  });

  test("a finished sentence is never held", () => {
    for (const text of [
      "I want to book an appointment.",
      "What are your opening hours?",
      "Yes, that is right.",
      "Thanks!",
      "Monday at ten",
      "my phone number is 0300 1234567",
      "جی ہاں",
      "میرا نام احمد ہے۔",
      "کیا آپ کھلے ہیں؟",
      "kal subah ten baje",
      "",
    ]) {
      assert.equal(looksUnfinished(text), false, text);
    }
  });
});

describe("unreadableScript", () => {
  test("a transcript in a script nobody speaks to this agent is named — the recogniser guessed the language wrong (a real call: \"No, nothing\" in Cyrillic)", () => {
    assert.equal(unreadableScript("Нет, ничего."), "Cyrillic");
    assert.equal(unreadableScript("Hello Привет мир"), "Cyrillic", "half or more of the letters");
    assert.equal(unreadableScript("你好，谢谢"), "Han");
    assert.equal(unreadableScript("감사합니다"), "Hangul");
    assert.equal(unreadableScript("שלום"), "Hebrew");
    assert.equal(unreadableScript("ευχαριστώ"), "Greek");
  });

  test("English, Urdu script, Roman Urdu, Devanagari (stt.js asks for it again as Urdu) and mixed speech are readable", () => {
    for (const text of [
      "No, nothing.",
      "Oui.",
      "نہیں بس شکریہ",
      "جی میں order کرنا چاہتا ہوں",
      "nahi shukriya",
      "बता",
      "Nyron کو کال کرنے کا شکریہ 0300 1234567",
      "Café résumé naïve", // accents are still Latin
    ]) assert.equal(unreadableScript(text), null, text);
  });

  test("one stray foreign letter inside a real sentence does not make it unreadable; nothing to read is not 'unreadable' either", () => {
    assert.equal(unreadableScript("What are your opening hoursд today"), null);
    assert.equal(unreadableScript("آپ کے اوقات کیاй ہیں"), null);
    for (const text of ["", "   ", "1234", "?!", null, undefined]) assert.equal(unreadableScript(text), null, String(text));
  });
});
