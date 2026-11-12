import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { answersAgentQuestion, askedForDetail, statesPersonalDetails } from "@/lib/handoff/answers";
import { decideHandoff } from "@/lib/handoff/decide";
import { planHandoff } from "@/lib/handoff/turn";
import { normalizeHandoffConfig } from "@/lib/handoff/config";
import { classifyTurn, OUTCOMES } from "@/lib/voice/intent";
import { isProfileQuestion } from "@/lib/handoff/phrases";

/**
 * "DID THE AGENT FAIL TO UNDERSTAND, OR DID THE CALLER JUST ANSWER?" (CLAUDE.md §6.26)
 *
 * Found on three real console calls: "My name is Abdullah Yunus", "Oui." (after "May I have your phone number?")
 * and "no, that's all" each counted as the agent failing to understand — they are statements, not questions, so
 * they never match a document — and two in a row passed the caller to a person. These tests pin the cases.
 */

const ASKED_NAME = "We can arrange delivery within eight kilometres. May I have your name, please?";
const ASKED_PHONE_CUT = "Thank you, Abdullah. May I have your phone number so we can confirm your order";
const ASKED_ANYTHING_ELSE = "Thank you. I'll pass your details to our team. Is there anything else I can help with?";
const ASKED_HOW_HELP = "Hello, how can we help you today?";

describe("the caller answered the agent — it is not a question the documents failed on", () => {
  test("a name, after the agent asked for one", () => {
    assert.equal(answersAgentQuestion({ message: "My name is Abdullah Yunus.", previousReply: ASKED_NAME }), true);
    assert.equal(answersAgentQuestion({ message: "Abdullah Yunus", previousReply: ASKED_NAME }), true);
  });

  test("whatever comes back after a request for a detail, even a mis-transcribed fragment — if it is not a question", () => {
    assert.equal(answersAgentQuestion({ message: "Oui.", previousReply: ASKED_PHONE_CUT }), true, "the reply was cut off before its question mark: still a request for a detail");
    assert.equal(answersAgentQuestion({ message: "zero three four zero", previousReply: ASKED_PHONE_CUT }), true);
  });

  test("a statement about themselves needs no question before it", () => {
    for (const message of [
      "My name is Abdullah Yunus.",
      "I live near Lahore railway station, street number eight.",
      "My phone number is 03405216542.",
      "03405216542",
      "جی میرا نام عبداللہ یونس ہے اور میں لاہور میں ریلوے سٹیشن کے ساتھ رہتا ہوں۔",
      "mera naam Ahmed hai",
      "میرا نمبر صفر تین چار صفر پانچ دو ہے",
    ]) assert.equal(answersAgentQuestion({ message, previousReply: ASKED_HOW_HELP }), true, message);
  });

  test("'no thanks', 'okay', 'that's all' are answers, in the three ways of writing", () => {
    for (const message of ["No, nothing.", "No thanks.", "That's all, thank you.", "Okay.", "Yes please.", "نہیں شکریہ", "جی ٹھیک ہے", "nahi shukriya", "bas itna hi"]) {
      assert.equal(answersAgentQuestion({ message, previousReply: ASKED_ANYTHING_ELSE }), true, message);
    }
  });

  test("a QUESTION is never an answer — even right after the agent asked for a detail", () => {
    for (const message of [
      "How much is the fish and chips?",
      "Do you deliver to Gulberg?",
      "What are your opening hours?",
      "Can you tell me the price of the mixed platter",
      "کیا آپ ڈیلیوری کرتے ہیں؟",
      "فش اور چپس کتنے کے ہیں",
      "kya aap delivery karte hain",
      "Is there parking?",
    ]) {
      assert.equal(answersAgentQuestion({ message, previousReply: ASKED_NAME }), false, message);
      assert.equal(answersAgentQuestion({ message, previousReply: ASKED_HOW_HELP }), false, message);
    }
  });

  test("a bare topic after 'how can I help?' is still treated as a question — the agent asked for no detail", () => {
    assert.equal(answersAgentQuestion({ message: "Opening hours", previousReply: ASKED_HOW_HELP }), false);
    assert.equal(answersAgentQuestion({ message: "Do you do vegan options", previousReply: null }), false);
    assert.equal(answersAgentQuestion({ message: "delivery charges", previousReply: null }), false);
  });

  test("after the agent asked the caller to say it again, what comes back is another attempt at a question — it counts if it fails", () => {
    for (const previousReply of [
      "I'm sorry, I did not catch that. Could you say it another way?",
      "Sorry, could you say that another way?",
      "I didn't get that. Could you repeat it, please?",
      "Could you give me a bit more detail about what you need?",
      "معذرت، کیا آپ دوبارہ بتا سکتے ہیں؟",
      "maaf kijiye, kya aap dobara keh sakte hain?",
    ]) {
      assert.equal(answersAgentQuestion({ message: "wibble wobble flump zork", previousReply }), false, previousReply);
      assert.equal(askedForDetail(previousReply), false, previousReply);
    }
  });

  test("…but asking for a detail AGAIN is still asking for one", () => {
    assert.equal(askedForDetail("Sorry, I did not catch that. May I have your name again?"), true);
    assert.equal(askedForDetail("Thank you. May I have your phone number, please?"), true);
  });

  test("nothing said, nothing to judge", () => {
    assert.equal(answersAgentQuestion({ message: "", previousReply: ASKED_NAME }), false);
    assert.equal(answersAgentQuestion({ message: undefined, previousReply: undefined }), false);
  });

  test("what counts as the agent asking for a detail (the tail of its reply, cut off or not)", () => {
    for (const reply of [
      ASKED_NAME,
      ASKED_PHONE_CUT,
      "May I have a phone number to reach you, please?",
      "Could you give me your full street address and a contact phone number, please?",
      "Which day would you like, and at what time?",
      "Would you like pickup or delivery?",
      "آپ کا نام کیا ہے؟",
      "کیا آپ اپنا نام اور رابطے کی معلومات دینا چاہیں گے؟",
      "aap ka naam kya hai?",
    ]) assert.equal(askedForDetail(reply), true, reply);
    for (const reply of ["We open at nine. Anything else?", ASKED_HOW_HELP, ASKED_ANYTHING_ELSE, "", null]) assert.equal(askedForDetail(reply), false, String(reply));
  });

  test("what counts as stating one's own details", () => {
    assert.equal(statesPersonalDetails("I'm at Lahore railway station"), true);
    assert.equal(statesPersonalDetails("call me Bilal"), true);
    assert.equal(statesPersonalDetails("0300 1234567"), true);
    assert.equal(statesPersonalDetails("one two three"), false, "not enough digits to be a number");
    assert.equal(statesPersonalDetails("I want the charcoal BBQ"), false);
    assert.equal(statesPersonalDetails("The price is 1600"), false, "one number is not a phone number");
  });
});

describe("what that does to passing the caller on (the real call 1)", () => {
  const config = () => ({
    replyLanguage: "en",
    timezone: "UTC",
    hours: null,
    collect: {},
    escalation: normalizeHandoffConfig({ enabled: true, afterMisses: 2, contacts: [{ id: "c1", role: "Representative", name: "Adan", phone: "+923001234567" }] }),
  });
  const turnOf = (message, earlier, extra = {}) =>
    planHandoff({ config: config(), storedState: extra.state ?? null, message, earlierTurns: earlier, sources: [], collection: null, nowMs: Date.UTC(2026, 10, 12, 12), ...extra });

  const history = [
    { role: "assistant", content: "Hello, thanks for calling KO Restaurants. How can I help you today?" },
    { role: "user", content: "I want you to deliver us charcoal BBQ." },
    { role: "assistant", content: ASKED_NAME },
  ];

  test("'My name is…' then 'Oui.' — the caller was never misunderstood, so nobody is called", () => {
    const first = turnOf("My name is Abdullah Yunus.", history);
    assert.equal(first.plan, null, "answering a question is not a failure");
    assert.equal(first.state.misses, 0);

    const second = turnOf("Oui.", [...history, { role: "user", content: "My name is Abdullah Yunus." }, { role: "assistant", content: ASKED_PHONE_CUT }], { state: first.state });
    assert.equal(second.plan, null);
    assert.equal(second.state.misses, 0);
  });

  test("a real question with nothing in the documents still counts, and two in a row still pass the caller on", () => {
    const first = turnOf("Do you cater for weddings?", history);
    assert.equal(first.plan.kind, "rephrase");
    const second = turnOf("Do you do catering for big events then?", [...history, { role: "user", content: "Do you cater for weddings?" }, { role: "assistant", content: "Sorry, could you say that another way?" }], { state: first.state });
    assert.equal(second.plan.kind, "handoff");
    assert.equal(second.plan.reason, "not_understood");
  });

  test("an answer in between resets the count: a miss, an answer, a miss is not two in a row", () => {
    const miss = turnOf("Do you cater for weddings?", history);
    assert.equal(miss.state.misses, 1);
    const answer = turnOf("My name is Abdullah.", [...history, { role: "assistant", content: ASKED_NAME }], { state: miss.state });
    assert.equal(answer.state.misses, 0);
  });

  test("decideHandoff on its own: the signal is respected, and the old signals are unchanged", () => {
    const base = { config: config().escalation, agent: config(), state: null, nowMs: Date.UTC(2026, 10, 12, 12) };
    const answered = decideHandoff({ ...base, message: "My name is Ali", turn: { question: true, hasSources: false, collecting: false, answersAgent: true } });
    assert.equal(answered.action, null);
    const asked = decideHandoff({ ...base, message: "Do you cater", turn: { question: true, hasSources: false, collecting: false, answersAgent: false } });
    assert.equal(asked.action.kind, "rephrase");
    // The caller saying they are not understood, or repeating themselves, is still a miss even if the words look like an answer.
    const complained = decideHandoff({ ...base, message: "you are not listening", turn: { question: true, hasSources: false, collecting: false, answersAgent: true } });
    assert.equal(complained.action.kind, "rephrase");
  });
});

describe("how the turn is logged", () => {
  test("an answer to the agent's own question is 'conversational', not 'no answer in your documents'", () => {
    const answered = classifyTurn({ callerText: "My name is Abdullah Yunus.", sources: [], answersAgent: true });
    assert.equal(answered.outcome, OUTCOMES.CONVERSATIONAL);
    const unanswered = classifyTurn({ callerText: "Do you cater for weddings?", sources: [], answersAgent: false });
    assert.equal(unanswered.outcome, OUTCOMES.NO_KNOWLEDGE);
    const grounded = classifyTurn({ callerText: "My name is Abdullah Yunus.", sources: ["menu.pdf"], answersAgent: true });
    assert.equal(grounded.outcome, OUTCOMES.ANSWERED, "a document that was used is still reported");
  });
});

describe("a question the business profile answers is not a failure, however badly it starts (the real call c54fa1d3)", () => {
  test("a stumbling lead-in does not hide 'who are you'", () => {
    for (const message of [
      "Hello, Cave Resturants. How... What... What you are and how you can help me.",
      "What you are and how you can help me.",
      "Um, hello. Who are you?",
      "Hello, KO Restaurants. How can you help me?",
      "what are you and what can you do for me",
    ]) assert.equal(isProfileQuestion(message, { businessName: "KO Restaurants" }), true, message);
  });

  test("it is still judged per clause, so a real question next to one is not hidden by it", () => {
    // These are NOT profile questions: nothing in them is about the business as a whole.
    for (const message of ["Hello. Do you cater for weddings?", "How much is the mixed platter and do you deliver to Gulberg", "Hello, how are you today"]) {
      assert.equal(isProfileQuestion(message, { businessName: "KO Restaurants" }), false, message);
    }
  });

  test("a plain one-clause message behaves exactly as before", () => {
    assert.equal(isProfileQuestion("Who are you?"), true);
    assert.equal(isProfileQuestion("What are your opening hours on Friday"), true);
    assert.equal(isProfileQuestion("Do you cater for weddings"), false);
    assert.equal(isProfileQuestion(""), false);
    assert.equal(isProfileQuestion(undefined), false);
  });
});
