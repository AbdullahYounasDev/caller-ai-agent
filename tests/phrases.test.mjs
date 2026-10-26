import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { detectOpener, isOverviewQuestion, mentionsNotice, normalizeText, OPENER_KINDS } from "@/lib/phrases";
import * as en from "@/lib/phrases/en";
import * as ur from "@/lib/phrases/ur";
import * as romanUr from "@/lib/phrases/roman-ur";
import { QUESTIONS } from "../scripts/eval-questions.mjs";
import { retrieveForTurn } from "@/lib/agent/query";
import { buildSystemInstruction } from "@/lib/agent/prompt";
import { classifyTurn } from "@/lib/voice/intent";
import { isProfileQuestion } from "@/lib/handoff/phrases";

// Generic openers (CLAUDE.md §6.20): the word lists per language (lib/phrases/en.js, ur.js,
// roman-ur.js) and what the brain does with a match. Pure — no database, no model.

const kind = (message, businessName = "Pizza Roma") => detectOpener(message, { businessName })?.kind ?? null;

describe("the word files", () => {
  test("every language file has every group, a filler list and the two notice lists", () => {
    for (const file of [en, ur, romanUr]) {
      for (const k of OPENER_KINDS) assert.ok(file.OPENERS[k]?.length > 0, k);
      assert.ok(file.FILLER.length > 10);
      assert.ok(file.NOTICE_WORDS.ai.length > 0 && file.NOTICE_WORDS.recording.length > 0);
    }
  });

  test("no alternative holds a space — a space separates WORDS of a phrase, so 'real person' inside a/b/c would silently break it", () => {
    for (const file of [en, ur, romanUr]) {
      for (const phrases of Object.values(file.OPENERS)) {
        for (const phrase of phrases) {
          for (const word of phrase.split(/\s+/)) assert.ok(!word.startsWith("/") && !word.endsWith("/"), `"${phrase}"`);
        }
      }
    }
  });

  test("a Roman Urdu spelling belongs to ONE word only", () => {
    const owner = new Map();
    for (const [canonical, variants] of Object.entries(romanUr.SPELLINGS)) {
      for (const v of variants) {
        if (v === canonical) continue;
        assert.ok(!owner.has(v) || owner.get(v) === canonical, `"${v}" is listed for both ${owner.get(v)} and ${canonical}`);
        owner.set(v, canonical);
      }
    }
  });

  test("text is normalised: contractions, Urdu diacritics and letter forms, punctuation", () => {
    assert.equal(normalizeText("What's your company about?"), "what is your company about");
    assert.equal(normalizeText("آپ کَون ہیں؟"), "آپ کون ہیں");
    assert.equal(normalizeText("كيا"), "کیا"); // Arabic kaf/yeh → Urdu
  });
});

describe("recognising a generic opener", () => {
  test("English", () => {
    const cases = {
      "Who are you?": "identity",
      "who am I speaking to": "identity",
      "Hi, could you please tell me a bit about your company?": "about",
      "give me overview about your company": "about",
      "what's your business about": "about",
      "What do you do?": "offerings",
      "what type of services you provide": "offerings",
      "What services do you offer for kids?": "offerings",
      "what does Pizza Roma do": "offerings",
      "what does Pizza do": "offerings", // the start of the name is how callers say it
      "how can you help me": "help",
      "Are you a robot?": "aiCheck",
      "am I talking to a real person": "aiCheck",
      "is this an automated call": "aiCheck",
    };
    for (const [message, expected] of Object.entries(cases)) assert.equal(kind(message), expected, message);
  });

  test("Urdu script", () => {
    const cases = {
      "آپ کون ہیں؟": "identity",
      "میں کس سے بات کر رہا ہوں": "identity",
      "اپنی کمپنی کے بارے میں بتائیں": "about",
      "اپنے بارے میں کچھ بتائیں": "about",
      "آپ کیا کرتے ہیں": "offerings",
      "آپ کی سروسز کیا ہیں؟": "offerings",
      "آپ میری کیا مدد کر سکتے ہیں": "help",
      "کیا آپ روبوٹ ہیں؟": "aiCheck",
      "کیا میں کسی انسان سے بات کر رہا ہوں": "aiCheck",
    };
    for (const [message, expected] of Object.entries(cases)) assert.equal(kind(message), expected, message);
  });

  test("Roman Urdu, in the spellings people actually use", () => {
    const cases = {
      "ap kon ho": "identity",
      "aap kaun hain": "identity",
      "apni company ke bare me batao": "about",
      "apne baare mein kuch bataein": "about",
      "aap kia karte hain?": "offerings",
      "aap ki services kya hai": "offerings",
      "aap kaun si services dete ho": "offerings",
      "ap meri kya madad kar sakte hain": "help",
      "kya ap insan ho": "aiCheck",
      "kya ye robot hai": "aiCheck",
    };
    for (const [message, expected] of Object.entries(cases)) assert.equal(kind(message), expected, message);
  });

  test("an ordinary question is NOT an opener — a specific thing is asked", () => {
    for (const message of [
      "tell me about your refund policy",
      "who is this plan for?",
      "How much is the Pro plan?",
      "What are your opening hours?",
      "what can you do about my late order",
      "what's your clinic software called",
      "پرو پلان کی قیمت کیا ہے",
      "pro plan ka price kya hai",
      "I want to book a table for four",
      "",
    ]) {
      assert.equal(kind(message, "Nyron Software Solutions"), null, message);
    }
  });

  test("measured on the eval set: every generic opener found, nothing else matched", () => {
    // Tuned with this set in view — read it as "fits the set", not as a live rate (§6.20).
    let openers = 0;
    let found = 0;
    for (const q of QUESTIONS) {
      const hit = isOverviewQuestion(q.q, { businessName: "Nyron Software Solutions" });
      if (["generic_overview", "report_phrasings"].includes(q.category)) {
        openers++;
        if (hit) found++;
      } else {
        assert.equal(hit, false, `${q.category}: ${q.q}`);
      }
    }
    assert.equal(found, openers);
  });

  test("the notice words: an AI mention and a recording mention, on word edges", () => {
    assert.equal(mentionsNotice("You're speaking with our AI assistant", "ai"), true);
    assert.equal(mentionsNotice("He said hello", "ai"), false); // "ai" inside "said" does not count
    assert.equal(mentionsNotice("آپ ایک اے آئی اسسٹنٹ سے بات کر رہے ہیں", "ai"), true);
    assert.equal(mentionsNotice("aap AI assistant se baat kar rahe hain", "ai"), true);
    assert.equal(mentionsNotice("This call is being recorded", "recording"), true);
    assert.equal(mentionsNotice("یہ کال ریکارڈ کی جا رہی ہے", "recording"), true);
    assert.equal(mentionsNotice("Welcome to Pizza Roma", "recording"), false);
  });
});

describe("what the brain does with an opener", () => {
  const history = [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello!" }];

  test("searched with the business name in front, no rewrite spent — first message or later", async () => {
    for (const h of [[], history]) {
      const seen = [];
      const turn = await retrieveForTurn({
        tenantId: "t",
        message: "What do you do?",
        history: h,
        businessName: "Pizza Roma",
        deps: { retrieve: async ({ query }) => (seen.push(query), [{ sourceTitle: "about.md" }]), rewrite: async () => assert.fail("no rewrite for an opener") },
      });
      assert.deepEqual(seen, ["Pizza Roma: What do you do?"]);
      assert.equal(turn.trigger, "overview");
      assert.equal(turn.searchQuery, "Pizza Roma: What do you do?");
      assert.equal(turn.opener.kind, "offerings");
    }
  });

  test("with no business name the opener is searched as typed", async () => {
    const seen = [];
    await retrieveForTurn({ tenantId: "t", message: "who are you", history: [], businessName: "", deps: { retrieve: async ({ query }) => (seen.push(query), []) } });
    assert.deepEqual(seen, ["who are you"]);
  });

  test("'are you a robot?' is not searched at all — the prompt answers it", async () => {
    const turn = await retrieveForTurn({ tenantId: "t", message: "Are you a robot?", history: [], businessName: "Pizza Roma", deps: { retrieve: async () => assert.fail("no search") } });
    assert.equal(turn.trigger, "ai_check");
    assert.deepEqual(turn.chunks, []);
  });

  test("the prompt: always honest about being an AI; a per-message line for openers only", () => {
    const config = { businessName: "Pizza Roma", purpose: "Italian restaurant in Dublin.", tone: "professional", timezone: "UTC", replyLanguage: "en", capabilities: {} };
    const plain = buildSystemInstruction({ config, channel: "voice" });
    assert.match(plain, /say honestly that you are the business's AI assistant; never claim to be a human/);
    assert.doesNotMatch(plain, /THIS MESSAGE/);
    assert.match(buildSystemInstruction({ config, channel: "voice", opener: { kind: "about" } }), /THIS MESSAGE is a general question about the business/);
    const robot = buildSystemInstruction({ config, channel: "voice", opener: { kind: "aiCheck" } });
    assert.match(robot, /THIS MESSAGE asks whether you are a person or a machine.*AI assistant for Pizza Roma/);
    // The conflict rule stays the LAST section when it is present.
    const two = buildSystemInstruction({ config, channel: "voice", opener: { kind: "about" }, chunks: [{ sourceTitle: "a.md", content: "x" }, { sourceTitle: "b.md", content: "y" }] });
    assert.match(two.split("\n\n").at(-1), /^IF DOCUMENTS DISAGREE/);
  });

  test("an opener answered from the profile is logged as such, not as a gap in the documents", () => {
    assert.equal(classifyTurn({ callerText: "who are you", sources: [], trigger: "overview" }).outcome, "profile");
    assert.equal(classifyTurn({ callerText: "are you a robot", sources: [], trigger: "ai_check" }).outcome, "profile");
    assert.equal(classifyTurn({ callerText: "who are you", sources: ["about.md"], trigger: "overview" }).outcome, "answered");
    assert.equal(classifyTurn({ callerText: "do you sell bikes", sources: [] }).outcome, "no_knowledge");
  });

  test("an opener never counts as 'the agent did not understand' for passing a caller on", () => {
    for (const message of ["tell me about your company", "aap kya karte hain", "آپ کی سروسز کیا ہیں", "are you a real person"]) {
      assert.equal(isProfileQuestion(message), true, message);
    }
    assert.equal(isProfileQuestion("do you sell bicycles"), false);
  });
});
