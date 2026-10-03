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

  test("an Italian question is filtered with the Italian list too", () => {
    assert.deepEqual(terms("Quanto costa il piano ClinicHMS Growth?"), ["costa", "piano", "clinichms", "growth"]);
    assert.deepEqual(terms("Qual è la vostra politica di rimborso per gli abbonamenti annuali?"), ["politica", "rimborso", "abbonamenti", "annuali"]);
  });

  test("apostrophes split words: contractions and Italian elisions leave no junk terms", () => {
    assert.deepEqual(terms("what's your clinic software called"), ["clinic", "software", "called"]);
    assert.deepEqual(terms("Qual è l'orario dell'assistenza?"), ["orario", "assistenza"]);
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
    for (const q of ["who are you", "what do you do", "tell me about you", "", "   ", null, undefined, "?!", "e il"]) {
      assert.deepEqual(buildKeywordQuery(q), { terms: [], tsquery: "" }, String(q));
    }
  });

  test("accented and non-Latin letters survive as terms", () => {
    assert.deepEqual(terms("perché è così caro il caffè"), ["così", "caro", "caffè"]);
    assert.deepEqual(terms("سعر الخطة"), ["سعر", "الخطة"]);
  });

  test("SAFE for to_tsquery: no operator character can reach the query", () => {
    for (const hostile of ["a & b | !c", "x:* <-> y", "foo'); DROP TABLE x;--", "(a|b)&!c", "plan\\ pro\u0000", "a:b c<2>d"]) {
      const { terms: t, tsquery } = buildKeywordQuery(hostile);
      for (const term of t) assert.match(term, /^[\p{L}\p{N}]+$/u, `${hostile} -> ${term}`);
      assert.match(tsquery, /^[\p{L}\p{N}]+( \| [\p{L}\p{N}]+)*$|^$/u, hostile);
    }
  });

  test("the stop list holds the filler it promises and none of the words a customer actually asks about", () => {
    for (const w of ["the", "what", "how", "much", "your", "tell", "guys", "il", "della", "quanto", "vostra", "dell", "s"]) {
      assert.ok(KEYWORD_STOPWORDS.has(w), w);
    }
    for (const w of ["price", "plan", "refund", "hours", "support", "free", "trial", "cancel", "cost", "costa", "prezzo", "orari", "rimborso", "pro", "starter", "growth", "enterprise"]) {
      assert.ok(!KEYWORD_STOPWORDS.has(w), `${w} is content, not filler`);
    }
  });
});
