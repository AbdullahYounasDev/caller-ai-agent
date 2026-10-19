import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { detectStartType, isCancel, isSkip, confirmationOf, looksLikeQuestion } from "@/lib/collect/phrases";

const BOTH = ["appointment", "callback"];

describe("detectStartType", () => {
  test("asking for an appointment, in three ways of writing", () => {
    for (const m of [
      "I'd like to book an appointment for tomorrow",
      "Can I see the doctor on Friday?",
      "I want to reserve a table for four",
      "مجھے اپائنٹمنٹ بک کرنی ہے",
      "کل کے لیے بکنگ چاہیے",
      "mujhe doctor se milna hai",
      "Pro plan ki appointment book karni hai",
      "kal ke liye time chahiye",
      "mujhe doctor ko dikhana hai",
    ]) {
      assert.equal(detectStartType(m, BOTH), "appointment", m);
    }
  });

  test("asking to be called back", () => {
    for (const m of [
      "Please call me back later today",
      "can someone call me about my order",
      "مجھے واپس کال کریں",
      "برائے مہربانی کال بیک کر دیں",
      "mujhe wapas call karein please",
      "aap mujhe call karein",
    ]) {
      assert.equal(detectStartType(m, BOTH), "callback", m);
    }
  });

  test("a message that mentions both is about whichever it asks for first", () => {
    assert.equal(detectStartType("call me back to book an appointment", BOTH), "callback");
    assert.equal(detectStartType("I want to book an appointment, and call me to confirm", BOTH), "appointment");
  });

  test("only the types the business switched on can start", () => {
    assert.equal(detectStartType("book an appointment", ["callback"]), null);
    assert.equal(detectStartType("call me back", ["appointment"]), null);
    assert.equal(detectStartType("book an appointment", []), null);
  });

  test("changing or cancelling an existing booking is not a new request", () => {
    for (const m of ["I want to cancel my appointment", "can I reschedule", "میری اپائنٹمنٹ منسوخ کریں", "appointment cancel karna hai"]) {
      assert.equal(detectStartType(m, BOTH), null, m);
    }
  });

  test("ordinary questions and small talk start nothing", () => {
    for (const m of ["What are your opening hours?", "how much is a root canal", "شکریہ", "آپ کی فیس کتنی ہے", "hello", "", null, undefined]) {
      assert.equal(detectStartType(m, BOTH), null, String(m));
    }
  });

  test("a word that merely contains a trigger word does not start anything", () => {
    assert.equal(detectStartType("do you have visiting hours", BOTH), null);
    assert.equal(detectStartType("this is a rebooking policy", BOTH), null);
  });
});

describe("isCancel", () => {
  test("unmistakable refusals cancel at any time", () => {
    for (const m of ["cancel it", "forget it", "I changed my mind", "stop", "نہیں چاہیے", "منسوخ کر دیں", "nahi chahiye", "cancel kar do"]) {
      assert.equal(isCancel(m), true, m);
      assert.equal(isCancel(m, { askingOptional: true }), true, `${m} (optional)`);
    }
  });

  test("a weak 'never mind' cancels only when the question could not be skipped", () => {
    for (const m of ["never mind", "not now", "رہنے دیں", "چھوڑیں", "rehne do", "abhi nahi"]) {
      assert.equal(isCancel(m), true, m);
      assert.equal(isCancel(m, { askingOptional: true }), false, `${m} (optional)`);
    }
  });

  test("an answer that merely contains such a word is not a cancellation", () => {
    assert.equal(isCancel("my name is Stopford Khan"), false);
    assert.equal(isCancel("I can come later in the evening if that works for the team"), false, "long messages are answers");
    assert.equal(isCancel("Ahmed"), false);
  });
});

describe("isSkip", () => {
  test("a short refusal of an optional question", () => {
    for (const m of ["no", "No thanks", "skip", "none", "nothing", "نہیں", "کوئی نہیں", "nahi", "koi nahi", "rehne do", "رہنے دیں"]) {
      assert.equal(isSkip(m), true, m);
    }
  });

  test("an answer is not a skip, however many 'no's are in it", () => {
    for (const m of ["notes: no parking available near the clinic at all", "Ahmed", "my email is a@b.com", ""]) assert.equal(isSkip(m), false, m);
  });
});

describe("confirmationOf", () => {
  test("yes in three languages", () => {
    for (const m of ["yes", "Yes, that's right", "correct", "go ahead", "ہاں", "جی ہاں بالکل", "ٹھیک ہے", "ji haan", "theek hai", "kar do", "sab theek hai"]) {
      assert.equal(confirmationOf(m), "yes", m);
    }
  });

  test("no, or 'something is wrong', in three languages", () => {
    for (const m of ["no", "No, the phone number is wrong", "wrong", "that's not right", "نہیں", "غلط ہے", "نہیں، نمبر غلط ہے", "nahi", "galat hai", "time galat hai"]) {
      assert.equal(confirmationOf(m), "no", m);
    }
  });

  test("a denial beats a stray 'ok' in the same sentence", () => {
    assert.equal(confirmationOf("ٹھیک ہے مگر نمبر غلط ہے"), "no");
    assert.equal(confirmationOf("theek hai lekin time galat hai"), "no");
  });

  test("something else is neither", () => {
    for (const m of ["what are your opening hours?", "can I pay by card", "", null, "hmm"]) assert.equal(confirmationOf(m), null, String(m));
  });
});

describe("looksLikeQuestion", () => {
  test("recognises a question by its mark or its opening word, in three ways of writing", () => {
    for (const m of ["What time do you close?", "how much is it", "آپ کب کھلتے ہیں؟", "کیا آپ اتوار کو کھلے ہیں", "kya aap Sunday ko open hain", "kitna lagega"]) assert.equal(looksLikeQuestion(m), true, m);
    for (const m of ["Ahmed Khan", "0300 1234567", "tomorrow at five", "احمد خان", "kal shaam"]) assert.equal(looksLikeQuestion(m), false, m);
  });
});
