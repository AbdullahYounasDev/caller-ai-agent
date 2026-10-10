import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { needsContext, isAcknowledgement, concatQuery } from "@/lib/agent/query";

describe("needsContext — does this message depend on the conversation before it?", () => {
  test("complete standalone questions (English and Italian) do not", () => {
    for (const q of [
      "How much is the StorePulse Pro plan per month?",
      "What are your opening hours on Saturdays?",
      "Do you offer teeth whitening for adults?",
      "Quanto costa il piano Growth al mese?",
      "Quali sono i vostri orari di apertura il sabato?",
    ]) {
      assert.equal(needsContext(q), false, q);
    }
  });

  test("four words or fewer is too short to stand alone; five is not", () => {
    assert.equal(needsContext("how much?"), true);
    assert.equal(needsContext("Pro plan price please"), true, "4 words");
    assert.equal(needsContext("Is Pro plan price available"), false, "5 words");
  });

  test("English ellipsis openers", () => {
    for (const q of [
      "And the Growth one for a team of ten people?",
      "But what happens when we exceed the limit?",
      "What about Sundays and public holidays here?",
      "How about the annual option for two stores?",
      "Also do you ship abroad with tracking numbers?",
    ]) {
      assert.equal(needsContext(q), true, q);
    }
  });

  test("Italian ellipsis openers", () => {
    for (const q of [
      "E il piano Pro per due negozi diversi?",
      "Ma anche il sabato siete aperti per i clienti?",
      "Invece per le aziende cosa prevedete come offerta?",
      "Allora quanto costerebbe in totale per un anno?",
    ]) {
      assert.equal(needsContext(q), true, q);
    }
  });

  test("anaphora — a message that points back at something already said", () => {
    for (const q of [
      "Does it include support for two different stores?",
      "Is that included in the monthly price you quoted?",
      "How much is the second one for a team of five?",
      "Can I cancel them at any time without a penalty?",
      "Quanto costa quello con più utenti inclusi nel piano?",
      "Questa opzione comprende anche l'assistenza telefonica?",
    ]) {
      assert.equal(needsContext(q), true, q);
    }
  });

  test("bare 'one', 'la' and 'ci' inside a complete question do NOT fire (they are listed as too common)", () => {
    assert.equal(needsContext("Can I use up to one store on the Starter plan?"), false);
    assert.equal(needsContext("Dove posso trovare la fattura del mese scorso?"), false);
  });

  test("empty, nullish and pleasantries never trigger a rewrite", () => {
    for (const q of ["", "   ", null, undefined, "ok", "Thanks!", "grazie"]) assert.equal(needsContext(q), false, String(q));
  });
});

describe("isAcknowledgement — pleasantry detection", () => {
  test("English and Italian acknowledgements, any case and punctuation", () => {
    for (const m of ["ok", "OK!", "Okay.", "Thanks!", "thank you", "yes please", "got it", "bye", "va bene", "grazie", "Grazie, ciao!", "sì, certo", "perfetto"]) {
      assert.equal(isAcknowledgement(m), true, m);
    }
  });

  test("up to three acknowledgement phrases, not four", () => {
    assert.equal(isAcknowledgement("okay, great, thanks"), true);
    assert.equal(isAcknowledgement("ok thanks great bye"), false);
  });

  test("anything carrying content is not a pleasantry", () => {
    for (const m of ["yes the Pro one", "thanks, and the price?", "no", "ok what are your hours", "hello I need a refund"]) {
      // "no" alone IS in the list; asserted separately below.
      if (m === "no") continue;
      assert.equal(isAcknowledgement(m), false, m);
    }
    assert.equal(isAcknowledgement("no"), true);
  });

  test("empty and nullish are not acknowledgements", () => {
    for (const m of ["", "   ", null, undefined]) assert.equal(isAcknowledgement(m), false, String(m));
  });
});

describe("concatQuery", () => {
  test("prepends the customer's most recent PREVIOUS question, ignoring assistant turns", () => {
    const history = [
      { role: "user", content: "How much is the Pro plan?" },
      { role: "assistant", content: "Pro is 49 euros a month." },
    ];
    assert.equal(concatQuery({ history, message: "and Growth?" }), "How much is the Pro plan? and Growth?");
  });

  test("no earlier customer turn → the message as typed", () => {
    assert.equal(concatQuery({ history: [{ role: "assistant", content: "Hello!" }], message: "hi" }), "hi");
    assert.equal(concatQuery({ history: [], message: "hi" }), "hi");
  });

  test("blank earlier turns are skipped", () => {
    const history = [
      { role: "user", content: "Opening hours?" },
      { role: "user", content: "   " },
    ];
    assert.equal(concatQuery({ history, message: "and Sunday?" }), "Opening hours? and Sunday?");
  });
});

describe("needsContext — precision rules (scripts/eval-trigger.mjs has the measured effect)", () => {
  test("a short message that addresses the business directly is a complete question, not a follow-up", () => {
    for (const q of ["who are you", "what do you do", "What's your ragù recipe?", "Do you ship abroad?", "Chi siete voi?", "Qual è la vostra sede?"]) {
      assert.equal(needsContext(q), false, q);
    }
  });

  test("…as is the 'what does X do/about' overview opener, whatever X is", () => {
    for (const q of ["what does nyron do", "what is nyron about", "What does Acme sell?"]) assert.equal(needsContext(q), false, q);
  });

  test("a short message naming a brand or carrying a number is anchored", () => {
    for (const q of ["Is Pro included?", "StorePulse Lite price", "ClinicHMS refunds?", "plan 5 limits"]) assert.equal(needsContext(q), false, q);
  });

  test("but an elliptical short message is still a follow-up — RECALL is protected", () => {
    for (const q of ["how much?", "Who pays for shipping?", "Can I change the wording?".slice(0, 20), "price for weekends", "e il sabato"]) {
      // "Can I change the wor" is 5 words? no: 5 -> not short; exclude from the short assertion below
      if (q.split(/\s+/).length > 4) continue;
      assert.equal(needsContext(q), true, q);
    }
    assert.equal(needsContext("Who pays for shipping?"), true, "no business-noun exemption: it would drop this real follow-up");
  });

  test("openers and strong pointers fire regardless of the exemptions", () => {
    assert.equal(needsContext("And what do you do?"), true, "opener beats the second-person exemption");
    assert.equal(needsContext("What about your Pro plan?"), true);
    assert.equal(needsContext("Is that included?"), true);
    assert.equal(needsContext("How much is it?"), true);
  });

  test("'this' points back only as a pronoun or before a generic noun", () => {
    assert.equal(needsContext("Is this included in the price you mentioned earlier?"), true, "pronoun before a verb");
    assert.equal(needsContext("Can you tell me more about this?"), true, "bare pronoun at the end");
    assert.equal(needsContext("Does this plan include phone support for two stores?"), true, "generic noun");
    assert.equal(needsContext("what's this new connect thing you're building"), false, "introduces its own referent");
    assert.equal(needsContext("can I use this on more than one shop location"), false);
  });

  test("'there' points back only at the END of a message", () => {
    assert.equal(needsContext("Do you deliver to Milan and also over there?"), true);
    assert.equal(needsContext("is my info still there if I cancel and come back later"), false);
    assert.equal(needsContext("Is there parking available at your clinic for patients?"), false, "existential 'there'");
  });

  test("'the X one' points back in a short message but not as the tail of a long, complete question", () => {
    assert.equal(needsContext("How much is the Pro one for a team?"), true);
    assert.equal(needsContext("whats included when I sign up as an enterprise customer for the clinic one"), false, "14 words");
    assert.equal(needsContext("What do the numbers look like for the second one in your price list page?"), true, "ordinals always point back");
  });
});
