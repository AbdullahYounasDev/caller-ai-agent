import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildKeywordQuery, KEYWORD_STOPWORDS } from "@/lib/agent/keyword-query";

const terms = (q) => buildKeywordQuery(q).terms;

describe("buildKeywordQuery", () => {
  test("keeps the content words of an English question, drops the filler, preserves order", () => {
    assert.deepEqual(terms("How many practitioners can the ClinicHMS Growth plan support?"), ["practitioners", "clinichms", "growth", "plan", "support"]);
    assert.equal(buildKeywordQuery("How much is the Pro plan?").tsquery, "pro | plan");
  });

  test("an Urdu question (script) is filtered with the Urdu list: the `simple` config has no stop words of its own", () => {
    assert.deepEqual(terms("آپ کی clinic timings کیا ہیں؟"), ["clinic", "timings"]);
    assert.deepEqual(terms("بریسز کتنے کے لگتے ہیں اور کیا قسطوں میں ادائیگی ہو سکتی ہے؟"), ["بریسز", "لگتے", "قسطوں", "ادائیگی"]);
    assert.deepEqual(terms("میں اپائنٹمنٹ بک کرنا چاہتا ہوں"), ["اپائنٹمنٹ", "بک"]);
  });

  test("a Roman Urdu question is filtered too", () => {
    assert.deepEqual(terms("Consultation ki fees kitni hai?"), ["consultation", "fees"]);
    assert.deepEqual(terms("Pro plan ki monthly fee kya hai"), ["pro", "plan", "monthly", "fee"]);
    assert.deepEqual(terms("kya aap Sunday ko open hain"), ["sunday", "open"]);
  });

  test("apostrophes split words: contractions leave no junk terms", () => {
    assert.deepEqual(terms("what's your clinic software called"), ["clinic", "software", "called"]);
    assert.deepEqual(terms("I don't know what you’re building"), ["building"]);
  });

  test("terms are lowercased, de-duplicated and capped at 12", () => {
    assert.deepEqual(terms("Plan PLAN plan Plan"), ["plan"]);
    const many = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    assert.equal(terms(many).length, 12);
    assert.equal(terms(many)[0], "word0");
  });

  test("digits are kept (a plan number, a price) but a lone letter is not", () => {
    assert.deepEqual(terms("plan 5 or x"), ["plan", "5"]);
    assert.deepEqual(terms("219 euros"), ["219", "euros"]);
  });

  test("nothing but filler gives an EMPTY query, which the caller must treat as 'fall back to AND'", () => {
    for (const q of ["who are you", "what do you do", "tell me about you", "", "   ", null, undefined, "?!", "aap kaun hain", "آپ کیا ہیں"]) {
      assert.deepEqual(buildKeywordQuery(q), { terms: [], tsquery: "" }, String(q));
    }
  });

  test("non-Latin letters survive as terms", () => {
    assert.deepEqual(terms("فیس کی تفصیل"), ["فیس", "تفصیل"]);
    assert.deepEqual(terms("café menu"), ["café", "menu"]);
  });

  test("SAFE for to_tsquery: no operator character can reach the query", () => {
    for (const hostile of ["a & b | !c", "x:* <-> y", "foo'); DROP TABLE x;--", "(a|b)&!c", "plan\\ pro\u0000", "a:b c<2>d"]) {
      const { terms: t, tsquery } = buildKeywordQuery(hostile);
      for (const term of t) assert.match(term, /^[\p{L}\p{N}]+$/u, `${hostile} -> ${term}`);
      assert.match(tsquery, /^[\p{L}\p{N}]+( \| [\p{L}\p{N}]+)*$|^$/u, hostile);
    }
  });

  test("the stop list holds the filler it promises and none of the words a customer actually asks about", () => {
    for (const w of ["the", "what", "how", "much", "your", "tell", "guys", "کیا", "ہے", "میں", "kya", "hai", "kitna", "s"]) {
      assert.ok(KEYWORD_STOPWORDS.has(w), w);
    }
    for (const w of ["price", "plan", "refund", "hours", "support", "free", "trial", "cancel", "cost", "fees", "timings", "فیس", "قیمت", "وقت", "pro", "starter", "growth", "enterprise"]) {
      assert.ok(!KEYWORD_STOPWORDS.has(w), `${w} is content, not filler`);
    }
  });
});
