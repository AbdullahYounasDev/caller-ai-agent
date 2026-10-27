import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { decideCallEnd, normalizeCallEnding, callEndingProblems, END_DELAY_SECONDS, CLOSING_TRIGGERS } from "@/lib/voice/closing";
import { asksAnythingElse, isDecliningMore, saysFarewell, lastSentence } from "@/lib/phrases";
import { classifyTurn } from "@/lib/voice/intent";

// Ending a call by itself (CLAUDE.md §6.24): rules decide, conservatively; the owner can switch it
// off or give callers more time. The session tests (voice-session) cover timing and speech.

const ON = { autoEndCalls: true, endCallDelaySeconds: 3 };
const decide = (callerText, reply, extra = {}) =>
  decideCallEnd({ settings: ON, callerText, intent: classifyTurn({ callerText, sources: [] }).intent, reply, ...extra });

describe("the words", () => {
  test("the agent asking whether there is anything else, in English and Urdu", () => {
    for (const reply of [
      "Is there anything else I can help you with?",
      "Glad I could help. Anything else?",
      "Do you have any other questions?",
      "Will that be all for today?",
      "کیا آپ کو کچھ اور جاننا ہے؟",
      "جی، اس کے علاوہ کوئی اور سوال؟",
      "Aap ko aur kuch chahiye?",
    ]) assert.ok(asksAnythingElse(reply), reply);
    for (const reply of ["We open at nine.", "Would you like to book it?", "And what is your name?"]) assert.ok(!asksAnythingElse(reply), reply);
  });

  test("only the LAST sentence counts: an earlier 'anything else' was already answered", () => {
    assert.ok(!asksAnythingElse("Anything else? Sure, the Pro plan is forty dollars."));
  });

  test("the caller declining more, in English, Urdu script and Roman Urdu", () => {
    for (const text of ["no", "No thanks.", "nope, I'm good", "no, that's all, thank you", "That's it, thanks so much!", "nothing else, bye", "I'm all set", "not today",
      "نہیں شکریہ", "جی نہیں، بس", "بس", "اور کچھ نہیں", "nahi shukriya", "bas ji", "nahin bas", "kuch nahi"]) {
      assert.ok(isDecliningMore(text), text);
    }
  });

  test("…but never a question, or a 'no' with something after it", () => {
    for (const text of ["no, I want to know more", "no, what about Sundays?", "no I need an appointment", "yes please", "nahi mujhe appointment chahiye",
      "bas ek sawal aur", "نہیں، مجھے اپائنٹمنٹ چاہیے", "Nothing about the price was clear to me, can you repeat it"]) {
      assert.ok(!isDecliningMore(text), text);
    }
  });

  test("the agent's farewell is a goodbye in its LAST sentence that asks nothing", () => {
    for (const reply of ["You're welcome! Have a great day.", "Thank you for calling. Goodbye!", "Goodbye, and take care!", "کال کرنے کا شکریہ، خدا حافظ۔", "Shukriya, Allah Hafiz."]) {
      assert.ok(saysFarewell(reply), reply);
    }
    for (const reply of ["Thanks for calling! How can I help?", "Thank you for calling Smile Care. Our hours are nine to five.", "Have a great day, is there anything else?", ""]) {
      assert.ok(!saysFarewell(reply), reply);
    }
  });

  test("the last sentence, and whether it is a question, in both scripts", () => {
    assert.deepEqual(lastSentence("We open at nine. Anything else?"), { text: "Anything else?", question: true });
    assert.deepEqual(lastSentence("کلینک نو بجے کھلتا ہے۔ کچھ اور؟"), { text: "کچھ اور؟", question: true });
    assert.deepEqual(lastSentence("Goodbye!  "), { text: "Goodbye!", question: false });
  });
});

describe("the decision", () => {
  test("the caller's short goodbye ends it; a goodbye is added only when the reply had none", () => {
    assert.deepEqual(decide("That's all, thanks. Bye.", "Goodbye!"), { end: true, trigger: CLOSING_TRIGGERS.CALLER_GOODBYE, sayClosingLine: false, delayMs: 3000 });
    assert.deepEqual(decide("Bye.", "You're welcome."), { end: true, trigger: CLOSING_TRIGGERS.CALLER_GOODBYE, sayClosingLine: true, delayMs: 3000 });
    assert.equal(decide("خدا حافظ", "اللہ حافظ۔").trigger, CLOSING_TRIGGERS.CALLER_GOODBYE);
  });

  test("'no thanks' ends it only right after 'anything else?'", () => {
    assert.equal(decide("No thanks.", "You're welcome.", { previousReply: "We open at nine. Anything else?" }).trigger, CLOSING_TRIGGERS.NO_MORE_QUESTIONS);
    assert.equal(decide("No thanks.", "No problem. Our cleaning is five thousand.", { previousReply: "Would you like to book whitening?" }).end, false);
    assert.equal(decide("nahi shukriya", "ٹھیک ہے۔", { previousReply: "کیا آپ کو کچھ اور جاننا ہے؟" }).trigger, CLOSING_TRIGGERS.NO_MORE_QUESTIONS);
  });

  test("the agent's own farewell ends it", () => {
    assert.deepEqual(decide("Great, thanks for the help.", "You're welcome! Have a great day."), { end: true, trigger: CLOSING_TRIGGERS.AGENT_FAREWELL, sayClosingLine: false, delayMs: 3000 });
  });

  test("never when the reply asks something, a request is half-taken, the caller asked to wait, a transfer is under way, the turn failed or was cut off", () => {
    assert.equal(decide("Bye.", "Before you go, may I have your number?").end, false);
    for (const extra of [{ requestOpen: true }, { onHold: true }, { handoff: true }, { failed: true }, { interrupted: true }]) {
      assert.equal(decide("That's all, thanks. Bye.", "Goodbye!", extra).end, false, JSON.stringify(extra));
    }
  });

  test("a long sentence that happens to say 'that's all' is not a goodbye", () => {
    assert.equal(decide("Well that's all very interesting but I still need to know about the price of the implants", "Implants start at fifty thousand.").end, false);
  });

  test("nothing ends while the owner has switched it off; the owner's wait is used", () => {
    assert.equal(decideCallEnd({ settings: { autoEndCalls: false }, callerText: "Bye.", intent: "goodbye", reply: "Goodbye!" }).end, false);
    assert.equal(decideCallEnd({ settings: { endCallDelaySeconds: 8 }, callerText: "Bye.", intent: "goodbye", reply: "Goodbye!" }).delayMs, 8000);
  });
});

describe("the settings", () => {
  test("read: on with 3 s unless set; a bad stored value degrades to the default", () => {
    assert.deepEqual(normalizeCallEnding(), { autoEndCalls: true, endCallDelaySeconds: END_DELAY_SECONDS.default });
    assert.deepEqual(normalizeCallEnding({ autoEndCalls: false, endCallDelaySeconds: 10 }), { autoEndCalls: false, endCallDelaySeconds: 10 });
    assert.equal(normalizeCallEnding({ endCallDelaySeconds: 60 }).endCallDelaySeconds, END_DELAY_SECONDS.default);
    assert.equal(normalizeCallEnding({ endCallDelaySeconds: "5" }).endCallDelaySeconds, 5);
  });

  test("saved: a switch, and a whole number of seconds from 2 to 10", () => {
    assert.deepEqual(callEndingProblems({}), []);
    assert.deepEqual(callEndingProblems({ autoEndCalls: true, endCallDelaySeconds: 2 }), []);
    assert.deepEqual(callEndingProblems({ autoEndCalls: "yes" }), [{ code: "autoEndInvalid" }]);
    for (const bad of [1, 11, 2.5, "3"]) {
      assert.deepEqual(callEndingProblems({ endCallDelaySeconds: bad }), [{ code: "delayRange", vars: { min: 2, max: 10 } }], String(bad));
    }
  });
});
