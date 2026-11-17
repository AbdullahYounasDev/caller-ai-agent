import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { falsePromise, firstHabit, inventedDescription, refusesToDescribe } from "../scripts/prompt-judges.mjs";

/**
 * The judges of `npm run prompt:probe`. Each case is a REAL kind of reply (several are samples from the measurements of
 * CLAUDE.md §6.24); a judge that mis-scores corrupts every prompt comparison built on it.
 */
describe("prompt-probe judges", () => {
  test("firstHabit: 'First,' as an opener, anywhere in the reply", () => {
    assert.equal(firstHabit("First, we open at nine."), true);
    assert.equal(firstHabit("Sure. First, we open at nine and then we close at six."), true);
    assert.equal(firstHabit("Firstly, we open at nine."), true);
    assert.equal(firstHabit("We open at nine. First, ask for a table."), true);
    assert.equal(firstHabit("We open at nine, and the first thing to know is we close at six."), false);
    assert.equal(firstHabit("We open first thing, at nine."), false);
    assert.equal(firstHabit("We open at nine every weekday."), false);
  });

  test("inventedDescription: saying what the business does, when it was never told", () => {
    assert.equal(inventedDescription("We provide software solutions and technology services."), true);
    assert.equal(inventedDescription("I'm the AI assistant. We build tools that help businesses grow."), true);
    assert.equal(inventedDescription("Nyron offers IT consulting for small companies."), true);
    assert.equal(inventedDescription("ہم سافٹ ویئر حل فراہم کرتے ہیں۔"), true);
  });

  test("inventedDescription: the honest answers are NOT flagged", () => {
    assert.equal(inventedDescription("I'm Nyron Software's AI assistant, and I don't have the details of what the business does. What do you need?"), false);
    assert.equal(inventedDescription("I'm the AI assistant for Nyron Software Solutions. How can I help you today?"), false, "the business's own name may say Software");
    assert.equal(inventedDescription("I'm sorry, I have not been given that information. Would you like to leave your number?"), false);
    assert.equal(inventedDescription("مجھے اس بارے میں معلومات نہیں ہیں۔ آپ کو کیا چاہیے؟"), false);
  });

  test("inventedDescription is judged per sentence: an honest sentence does not excuse an inventing one", () => {
    assert.equal(inventedDescription("I don't have the full details. We provide software solutions though."), true);
  });

  test("refusesToDescribe: an agent that WAS told must not say it does not know", () => {
    assert.equal(refusesToDescribe("I'm sorry, I don't have that information."), true);
    assert.equal(refusesToDescribe("That has not been provided to me."), true);
    assert.equal(refusesToDescribe("مجھے اس کی معلومات نہیں ہیں"), true);
    assert.equal(refusesToDescribe("We run a family dental clinic in Karachi offering checkups, braces and whitening."), false);
    assert.equal(refusesToDescribe("ہم کراچی میں ایک فیملی ڈینٹل کلینک چلاتے ہیں۔"), false);
  });
});

describe("prompt-probe judge: a promise the system cannot keep", () => {
  test("asking for personal details, or claiming something was noted / passed on, with no request started by the engine", () => {
    for (const text of [
      "Thank you. I'll pass your order and details to our team; they'll contact you shortly to confirm. Is there anything else I can help with?",
      "We can arrange delivery within eight kilometres. Please provide your delivery address and the items you'd like to order.",
      "Could you give me your full street address and a contact phone number, please?",
      "May I have your name, please?",
      "Sure, I'll note that down. براہِ کرم اپنا نام بتائیں۔",
      "Sure, I can note that down.",
      "I’m sorry, I can’t take delivery orders directly. I can arrange for a team member to call you back—may I have your name, please?",
      "Your order has been noted.",
      "Great, I have saved your details.",
      "آپ کا نام عبداللہ یونس اور پتہ لاہور ریلوے سٹیشن نوٹ ہو گیا۔ ہماری ٹیم جلد ہی آپ سے رابطہ کرے گی۔",
      "The team will contact you shortly.",
    ]) assert.equal(falsePromise(text), true, text);
  });

  test("an honest refusal, an offer or a plain answer is NOT flagged — and neither is anything the engine started (it opens with the marker)", () => {
    for (const text of [
      "I’m sorry, but I can’t take orders directly. I can connect you with a team member who can help with that. Would you like me to do that?",
      "میں معذرت چاہتی ہوں، لیکن اس بارے میں میرے پاس معلومات نہیں ہیں۔ کیا آپ چاہتے ہیں کہ ہماری ٹیم آپ سے رابطہ کرے؟",
      "We deliver within eight kilometres of Gulberg III. The delivery fee is one hundred fifty rupees, as noted in the KO Restaurant Price List.",
      "Would you like the team to call you back?",
      "To place the order you’ll need a team member — would you like me to take your name so we can arrange a callback for you?",
      "We open at nine every weekday.",
      "I’m sorry, I can’t take orders directly, but I can connect you with our team who can note it down.",
      "[[START callback]] Of course, I can take your details now. May I have your name?",
      "[[START appointment]]Thank you. I have noted that down. What is your phone number?",
      "",
    ]) assert.equal(falsePromise(text), false, text);
  });
});
