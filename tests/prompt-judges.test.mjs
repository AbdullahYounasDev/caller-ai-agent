import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { firstHabit, inventedDescription, refusesToDescribe } from "../scripts/prompt-judges.mjs";

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
