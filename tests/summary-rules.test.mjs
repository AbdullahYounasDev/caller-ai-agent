import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { priceMentions, stripPrices, summaryProblems, normalizeSummary, clipSummary, SUMMARY_MAX_CHARS } from "@/lib/agent/summary-rules";
import { buildSystemInstruction, buildSummaryInstruction, buildSummaryInput } from "@/lib/agent/prompt";

// The business summary (CLAUDE.md §6.20): general facts the agent always knows, never a price —
// prices go stale, and a summary is in every prompt.

describe("prices are kept out", () => {
  test("a currency next to a number, a rate per month, a percentage off — in English and Urdu", () => {
    for (const [text, found] of [
      ["Our Pro plan costs €149 per month.", "€149"],
      ["Biryani is Rs 450.", "Rs 450"],
      ["Plans from 59 euro/month", "59 euro"],
      ["قیمت 1500 روپے ہے", "1500 روپے"],
      ["Get 20% off today", "20% off"],
      ["Only $40", "$40"],
      ["PKR 2,500 for a checkup", "PKR 2,500"],
    ]) assert.deepEqual(priceMentions(text), [found], text);
  });

  test("ordinary numbers are not prices", () => {
    for (const text of ["We have served 2,000 clients since 2015.", "Open 9 to 5.", "Delivery in 30 minutes.", "We have 3 branches in Karachi."]) {
      assert.deepEqual(priceMentions(text), [], text);
    }
  });

  test("the AI's draft loses the sentences with a price, and says which", () => {
    const { text, removed } = stripPrices("Nyron builds clinic software. The Pro plan is €149 per month. We serve clinics in Karachi and Lahore.");
    assert.equal(text, "Nyron builds clinic software. We serve clinics in Karachi and Lahore.");
    assert.deepEqual(removed, ["The Pro plan is €149 per month."]);
  });

  test("a summary with a price is refused on save, whoever wrote it; too long is refused; empty is fine", () => {
    assert.deepEqual(summaryProblems("We sell biryani for Rs 450."), [{ code: "hasPrice", vars: { price: "Rs 450" } }]);
    assert.deepEqual(summaryProblems("x".repeat(SUMMARY_MAX_CHARS + 1)), [{ code: "tooLong", vars: { max: SUMMARY_MAX_CHARS } }]);
    assert.deepEqual(summaryProblems(""), []);
    assert.deepEqual(summaryProblems(null), []);
    assert.deepEqual(summaryProblems(42), [{ code: "invalid" }]);
    assert.deepEqual(summaryProblems("We are a dental clinic in Karachi."), []);
  });
});

describe("its form", () => {
  test("markdown and list marks are removed (it is spoken on calls); paragraphs kept", () => {
    assert.equal(normalizeSummary("## About\n- We **cook**\n- We deliver\n\n\n\nThanks"), "About\nWe cook\nWe deliver\n\nThanks");
  });

  test("a long draft is cut at the end of a sentence, never mid-word", () => {
    const sentence = "We are a family restaurant serving Pakistani food in Karachi. ";
    const clipped = clipSummary(sentence.repeat(40).trim());
    assert.ok(clipped.length <= SUMMARY_MAX_CHARS && clipped.endsWith("Karachi."), clipped.slice(-30));
    assert.equal(clipSummary("Short."), "Short.");
  });
});

describe("what the model is told", () => {
  test("writing it: general facts only, never prices or contact details, nothing invented, in the owner's language", () => {
    const en = buildSummaryInstruction({ language: "en", businessName: "Smile Care", maxWords: 120 });
    assert.match(en, /The business is called Smile Care\./);
    assert.match(en, /Write in English, at most 120 words/);
    assert.match(en, /NEVER INCLUDE prices, fees, costs, discounts, offers/);
    assert.match(en, /phone numbers, email or web addresses/);
    assert.match(en, /Never add anything the documents do not say/);
    assert.match(buildSummaryInstruction({ language: "ur", maxWords: 120 }), /Write in Urdu \(Urdu script\)/);
    assert.equal(buildSummaryInput([{ title: "01-company-overview.md", content: "We build software." }]), "DOCUMENT 1: company overview\nWe build software.");
  });

  test("answering: the approved summary is in ABOUT THIS BUSINESS, and the profile rule still keeps details to the documents", () => {
    const config = { businessName: "Smile Care", purpose: "", tone: "professional", replyLanguage: "en", profileSummary: "Smile Care is a dental clinic in Karachi.\nWe offer checkups and braces." };
    const prompt = buildSystemInstruction({ config, channel: "chat" });
    assert.match(prompt, /ABOUT THIS BUSINESS:\nName: Smile Care\nSummary of the business, from its own documents, approved by the owner: Smile Care is a dental clinic in Karachi\. We offer checkups and braces\./);
    assert.match(prompt, /what it costs — that comes from the reference material only/);
    assert.doesNotMatch(buildSystemInstruction({ config: { ...config, profileSummary: null }, channel: "chat" }), /approved by the owner/);
  });
});
