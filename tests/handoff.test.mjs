import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { emptyHandoffConfig, normalizeHandoffConfig, validateHandoffConfig, handoffAvailable, LIMITS } from "@/lib/handoff/config";
import { asksForHuman, saysNotUnderstood, repeatsPrevious, matchedTopic, isProfileQuestion, rankContacts } from "@/lib/handoff/phrases";
import { decideHandoff, newHandoffState, readHandoffState, summariseForPerson, isClosedNow } from "@/lib/handoff/decide";
import { planHandoff } from "@/lib/handoff/turn";
import { normalizeCollectConfig, presetConfig } from "@/lib/collect/config";

const CONTACTS = [
  { id: "c1", role: "Representative", name: "Bilal", phone: "0300 1234567" },
  { id: "c2", role: "Senior doctor", name: "Dr Ayesha", phone: "0321 5551234" },
];
const ON = (over = {}) => normalizeHandoffConfig({ enabled: true, contacts: CONTACTS, ...over });

describe("handoff settings", () => {
  test("a business that never set it up has it off, with sensible defaults", () => {
    const c = normalizeHandoffConfig(null);
    assert.deepEqual(c, emptyHandoffConfig());
    assert.equal(c.enabled, false);
    assert.equal(c.afterMisses, 2);
    assert.equal(c.whenCallerAsks, true);
    assert.equal(c.outsideHours, "callback");
    assert.equal(handoffAvailable(c), false);
  });

  test("phone numbers are stored in international form; ids are kept or made", () => {
    const c = ON();
    assert.deepEqual(c.contacts.map((x) => [x.id, x.phone]), [["c1", "+923001234567"], ["c2", "+923215551234"]]);
    assert.equal(handoffAvailable(c), true);
  });

  test("a stored document that is switched on with nobody to forward to is read as OFF", () => {
    assert.equal(normalizeHandoffConfig({ enabled: true, contacts: [] }).enabled, false);
    assert.equal(normalizeHandoffConfig({ enabled: true, contacts: [{ role: "x", phone: "12" }] }).enabled, false);
  });

  test("the old shape and junk never throw", () => {
    for (const raw of ["Call the owner.", 42, [], { email: "a@b.c", phone: "+39 02 0000000", whenUserAsks: false }, { contacts: "no" }, { afterMisses: "many" }]) {
      assert.doesNotThrow(() => normalizeHandoffConfig(raw));
    }
    assert.equal(normalizeHandoffConfig({ whenUserAsks: false }).whenCallerAsks, false);
  });

  test("saving: every problem comes back as a code the console translates", () => {
    const check = (raw) => validateHandoffConfig(raw).problems.map((p) => p.code);
    assert.deepEqual(check({ enabled: true, contacts: [] }), ["enabledNeedsContact"]);
    assert.deepEqual(check({ enabled: false, contacts: [{ role: "Manager", phone: "123" }] }), ["invalidPhone"]);
    assert.deepEqual(check({ contacts: [{ phone: "03001234567" }] }), ["contactIncomplete"]);
    assert.deepEqual(check({ contacts: [{ role: "A", phone: "03001234567" }, { role: "B", phone: "+92 300 1234567" }] }), ["duplicatePhone"]);
    assert.deepEqual(check({ afterMisses: 9 }), ["missesRange"]);
    assert.deepEqual(check({ afterMisses: 0 }), ["missesRange"]);
    assert.deepEqual(check({ outsideHours: "whenever" }), ["outsideHoursInvalid"]);
    assert.deepEqual(check({ topics: ["x".repeat(41)] }), ["topicTooLong"]);
    assert.deepEqual(check("nope"), ["invalid"]);
  });

  test("limits: too many contacts and topics are refused, an empty row is just dropped", () => {
    const many = Array.from({ length: LIMITS.contactsMax + 1 }, (_, i) => ({ role: `R${i}`, phone: `+92300123456${i}` }));
    assert.ok(validateHandoffConfig({ contacts: many }).problems.some((p) => p.code === "tooManyContacts"));
    const topics = Array.from({ length: LIMITS.topicsMax + 1 }, (_, i) => `topic${i}`);
    assert.ok(validateHandoffConfig({ topics }).problems.some((p) => p.code === "tooManyTopics"));
    const blank = validateHandoffConfig({ contacts: [{ role: "", name: "", phone: "" }, CONTACTS[0]] });
    assert.equal(blank.ok, true);
    assert.equal(blank.config.contacts.length, 1);
  });

  test("a valid document is ok and round-trips", () => {
    const result = validateHandoffConfig({ enabled: true, contacts: CONTACTS, afterMisses: 3, topics: ["complaint", "Complaint", " refund "], outsideHours: "forward" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.topics, ["complaint", "refund"]);
    assert.deepEqual(normalizeHandoffConfig(result.config), result.config);
  });
});

describe("asking for a person", () => {
  test("English, Urdu script and Roman Urdu", () => {
    for (const text of [
      "I want to speak to a person", "Can I talk to someone please", "put me through to the manager", "I need a real human", "let me speak with your representative",
      "connect me to the senior", "I want to speak to the owner", "customer service please", "get me an agent",
      "مجھے کسی انسان سے بات کرنی ہے", "مینیجر سے بات کروائیں", "میری بات کسی کو لائن پر دیں", "آپریٹر",
      "mujhe kisi insan se baat karni hai", "manager se baat karwa dein", "kisi ko line par dein", "operator se baat karao",
    ]) {
      assert.equal(asksForHuman(text), true, text);
    }
  });

  test("ordinary talk is not a request for a person", () => {
    for (const text of ["I want to book an appointment with Doctor Ayesha", "What time does the manager arrive?", "how much is a root canal", "Hello", "Thanks, bye", "my name is Ahmed", "I want to talk about prices", "tomorrow at five", "ڈاکٹر عائشہ کے ساتھ اپائنٹمنٹ چاہیے"]) {
      assert.equal(asksForHuman(text), false, text);
    }
  });
});

describe("signals of not being understood", () => {
  test("the caller says so", () => {
    for (const text of ["You don't understand me", "that's not what I asked", "I already told you my name", "are you even listening?", "آپ سمجھ نہیں رہے", "maine bataya tha", "aap samajh nahi rahe"]) {
      assert.equal(saysNotUnderstood(text), true, text);
    }
    for (const text of ["I understand, thanks", "what do you do", "yes please"]) assert.equal(saysNotUnderstood(text), false, text);
  });

  test("saying the same thing again is a signal; short or different messages are not", () => {
    assert.equal(repeatsPrevious("do you have parking near the clinic", "do you have parking near the clinic?"), true);
    assert.equal(repeatsPrevious("do you have free parking near the clinic", "do you have parking near the clinic"), true);
    assert.equal(repeatsPrevious("yes", "yes"), false);
    assert.equal(repeatsPrevious("what are your hours", "how much is a root canal"), false);
  });

  test("an owner's always-forward topic matches whole words, any language", () => {
    assert.equal(matchedTopic("I have a complaint about my bill", ["complaint"]), "complaint");
    assert.equal(matchedTopic("this is an emergency", ["Emergency"]), "Emergency");
    assert.equal(matchedTopic("مجھے شکایت کرنی ہے", ["شکایت"]), "شکایت");
    assert.equal(matchedTopic("complaints department", ["complaint"]), null, "whole words only");
    assert.equal(matchedTopic("hello", ["refund"]), null);
    assert.equal(matchedTopic("hello", []), null);
  });

  test("questions the business profile answers are not 'unanswered'", () => {
    for (const text of ["what are your opening hours?", "who are you", "when do you close", "are you open on Sunday", "where is your clinic", "آپ کے اوقات کیا ہیں", "aap kaun hain"]) {
      assert.equal(isProfileQuestion(text), true, text);
    }
    assert.equal(isProfileQuestion("do you sell bicycles"), false);
  });
});

describe("which contact", () => {
  test("the owner's order stands unless the caller names a role or a person", () => {
    assert.deepEqual(rankContacts(CONTACTS, "I want to speak to someone").map((c) => c.id), ["c1", "c2"]);
    assert.deepEqual(rankContacts(CONTACTS, "can I speak to the senior doctor").map((c) => c.id), ["c2", "c1"]);
    assert.deepEqual(rankContacts(CONTACTS, "put me through to bilal").map((c) => c.id), ["c1", "c2"]);
    assert.equal(rankContacts(CONTACTS, "ayesha please").length, 2, "every contact is kept for the fallback");
  });
});

// Wednesday 21 October 2026, 10:00 in Karachi — and 03:00 the same night.
const OPEN = Date.UTC(2026, 9, 21, 5, 0);
const CLOSED = Date.UTC(2026, 9, 21, 22, 0);
const HOURS = { mon: [["10:00", "20:00"]], tue: [["10:00", "20:00"]], wed: [["10:00", "20:00"]], thu: [["10:00", "20:00"]], fri: [["10:00", "20:00"]], sat: [["10:00", "20:00"]], sun: [] };
const AGENT = { timezone: "Asia/Karachi", hours: HOURS };
const MISS = { question: true, hasSources: false, collecting: false };
const FINE = { question: true, hasSources: true, collecting: false };

function run(steps, { config = ON(), nowMs = OPEN, agent = AGENT, callbackAvailable = false } = {}) {
  let state = newHandoffState();
  let previous = null;
  const out = [];
  for (const step of steps) {
    const { state: next, action } = decideHandoff({ config, agent, state, message: step.message ?? "tell me about the weather on mars", previousMessage: previous, turn: step.turn ?? MISS, nowMs, callbackAvailable, unheard: step.unheard });
    state = next;
    previous = step.message ?? previous;
    out.push(action);
  }
  return { out, state };
}

describe("deciding to pass the caller on", () => {
  test("off, or nobody to hand to: nothing ever happens", () => {
    for (const config of [emptyHandoffConfig(), normalizeHandoffConfig({ enabled: true, contacts: [] })]) {
      const { out } = run([{ message: "I want to speak to a person" }, { message: "you don't understand" }], { config });
      assert.deepEqual(out, [null, null]);
    }
  });

  test("asking for a person forwards at once, to the contact named if one was", () => {
    const { out, state } = run([{ message: "can I speak to the senior doctor", turn: FINE }]);
    assert.equal(out[0].kind, "handoff");
    assert.equal(out[0].reason, "asked");
    assert.deepEqual(out[0].contacts.map((c) => c.id), ["c2", "c1"]);
    assert.equal(state.status, "handed_off");
  });

  test("…unless the owner turned that off", () => {
    const { out } = run([{ message: "I want to speak to a person", turn: FINE }], { config: ON({ whenCallerAsks: false }) });
    assert.equal(out[0], null);
  });

  test("an always-forward topic forwards at once", () => {
    const { out } = run([{ message: "I want to make a complaint about the fee", turn: FINE }], { config: ON({ topics: ["complaint"] }) });
    assert.equal(out[0].reason, "topic");
  });

  test("not understanding: the first time it rephrases, the second time it forwards (afterMisses 2)", () => {
    const { out } = run([{ message: "what is the airspeed of a swallow" }, { message: "and the capital of mongolia please" }]);
    assert.deepEqual(out[0], { kind: "rephrase" });
    assert.equal(out[1].kind, "handoff");
    assert.equal(out[1].reason, "not_understood");
  });

  test("afterMisses 1 forwards on the first miss; 3 rephrases twice", () => {
    assert.equal(run([{ message: "xyzzy plugh" }], { config: ON({ afterMisses: 1 }) }).out[0].kind, "handoff");
    const three = run([{ message: "xyzzy plugh" }, { message: "foo bar baz qux" }, { message: "lorem ipsum dolor sit" }], { config: ON({ afterMisses: 3 }) }).out;
    assert.deepEqual(three.map((a) => a.kind), ["rephrase", "rephrase", "handoff"]);
  });

  test("a good answer in between resets the count: misses must be in a ROW", () => {
    const { out } = run([{ message: "xyzzy plugh" }, { message: "how much is a root canal", turn: FINE }, { message: "foo bar baz qux" }]);
    assert.deepEqual(out.map((a) => a?.kind ?? null), ["rephrase", null, "rephrase"]);
  });

  test("greetings, thanks, taking a request and profile questions are never misses", () => {
    const quiet = [
      { message: "hello", turn: { question: false, hasSources: false, collecting: false } },
      { message: "thanks", turn: { question: false, hasSources: false, collecting: false } },
      { message: "0300 1234567", turn: { question: true, hasSources: false, collecting: true } },
      { message: "what are your opening hours?", turn: MISS },
      { message: "who are you", turn: MISS },
    ];
    assert.deepEqual(run(quiet).out, [null, null, null, null, null]);
  });

  test("saying so, or repeating oneself, counts as a miss even when the documents answered", () => {
    assert.equal(run([{ message: "you don't understand what I'm asking", turn: FINE }]).out[0].kind, "rephrase");
    const repeated = run([{ message: "do you have parking near the clinic", turn: FINE }, { message: "do you have parking near the clinic?", turn: FINE }]).out;
    assert.deepEqual(repeated.map((a) => a?.kind ?? null), [null, "rephrase"]);
    const frustrated = run([{ message: "you don't understand me", turn: FINE }, { message: "that's not what I asked", turn: FINE }]).out[1];
    assert.equal(frustrated.reason, "frustrated");
  });

  test("speech that could not be made out counts too (the voice session reports it)", () => {
    const { out } = run([{ message: "", unheard: true }, { message: "", unheard: true }]);
    assert.deepEqual(out.map((a) => a.kind), ["rephrase", "handoff"]);
  });

  test("once passed on, it is not forwarded twice", () => {
    const { out } = run([{ message: "connect me to a person", turn: FINE }, { message: "hello? connect me to a person", turn: FINE }]);
    assert.equal(out[0].kind, "handoff");
    assert.deepEqual(out[1], { kind: "handed_off" });
  });

  test("closed hours: no transfer is promised — a call-back is offered; 'forward' forwards anyway", () => {
    const closed = run([{ message: "I want to speak to a person", turn: FINE }], { nowMs: CLOSED, callbackAvailable: true });
    assert.deepEqual(closed.out[0], { kind: "unavailable", reason: "closed", callback: true, contacts: [] });
    assert.equal(closed.state.status, null, "nobody was passed on");
    assert.equal(run([{ message: "I want to speak to a person", turn: FINE }], { nowMs: CLOSED }).out[0].callback, false);
    assert.equal(run([{ message: "I want to speak to a person", turn: FINE }], { nowMs: CLOSED, config: ON({ outsideHours: "forward" }) }).out[0].kind, "handoff");
    assert.equal(run([{ message: "I want to speak to a person", turn: FINE }], { nowMs: OPEN }).out[0].kind, "handoff");
  });

  test("a business with no opening hours on record is never 'closed'", () => {
    assert.equal(isClosedNow({ timezone: "Asia/Karachi", hours: null }, CLOSED), false);
    assert.equal(isClosedNow(AGENT, CLOSED), true);
    assert.equal(isClosedNow(AGENT, OPEN), false);
  });

  test("stored state is read defensively", () => {
    assert.deepEqual(readHandoffState(null), newHandoffState());
    assert.deepEqual(readHandoffState({ v: 99, misses: 5 }), newHandoffState());
    assert.equal(readHandoffState({ v: 1, misses: -3, status: "weird" }).misses, 0);
    assert.equal(readHandoffState({ v: 1, misses: 2, status: "handed_off" }).status, "handed_off");
  });
});

describe("what the person who picks up is told", () => {
  test("reason, what the caller said, and what was already taken down", () => {
    const text = summariseForPerson({ reason: "not_understood", callerMessages: ["first", "second", "third", "fourth"], details: [{ label: "Name", display: "Ahmed" }, { label: "Phone number", display: "0300 1234567" }] });
    assert.match(text, /could not understand or answer/);
    assert.match(text, /“second” · “third” · “fourth”/);
    assert.doesNotMatch(text, /first/);
    assert.match(text, /Already taken: Name Ahmed; Phone number 0300 1234567/);
  });

  test("long messages are clipped; nothing to say adds no empty lines", () => {
    assert.match(summariseForPerson({ reason: "asked", callerMessages: ["x".repeat(300)] }), /x{139}…/);
    assert.equal(summariseForPerson({ reason: "asked" }), "The caller asked to speak to a person.");
  });
});

describe("planHandoff — what respond() gets back", () => {
  const config = (over = {}) => ({ escalation: ON(over), timezone: "Asia/Karachi", hours: HOURS, collect: normalizeCollectConfig({ ...presetConfig("dental"), enabled: true }) });

  test("handoff off: nothing, and the state is untouched", () => {
    const r = planHandoff({ config: { escalation: emptyHandoffConfig(), collect: {} }, storedState: null, message: "I want a person", nowMs: OPEN });
    assert.deepEqual([r.changed, r.plan, r.result], [false, null, null]);
  });

  test("asked: the prompt plan has role and name but never the number; the adapter's result has everything", () => {
    const r = planHandoff({
      config: config(),
      storedState: null,
      message: "I want to talk to the senior doctor",
      earlierTurns: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "I have a toothache" }],
      sources: ["clinic.md"],
      collection: { state: "ask", collected: [{ label: "Name", display: "Ahmed" }] },
      nowMs: OPEN,
    });
    assert.equal(r.changed, true);
    assert.deepEqual(r.plan, { kind: "handoff", reason: "asked", callback: false, contact: { role: "Senior doctor", name: "Dr Ayesha" } });
    assert.ok(!JSON.stringify(r.plan).includes("+92"));
    assert.equal(r.result.contacts[0].phone, "+923215551234");
    assert.match(r.result.summary, /asked to speak to a person/);
    assert.match(r.result.summary, /“hi” · “I have a toothache” · “I want to talk to the senior doctor”|“I have a toothache”/);
    assert.match(r.result.summary, /Already taken: Name Ahmed/);
    assert.equal(r.state.status, "handed_off");
  });

  test("a miss is counted from the turn's own facts: a real question with no sources", () => {
    const first = planHandoff({ config: config(), storedState: null, message: "do you sell bicycles", sources: [], collection: null, nowMs: OPEN });
    assert.equal(first.plan.kind, "rephrase");
    assert.equal(first.state.misses, 1);
    const second = planHandoff({ config: config(), storedState: first.state, message: "what about scooters then", earlierTurns: [{ role: "user", content: "do you sell bicycles" }], sources: [], collection: null, nowMs: OPEN });
    assert.equal(second.plan.kind, "handoff");
    assert.equal(second.plan.reason, "not_understood");
  });

  test("a greeting, an answer with sources and a request in progress are not misses", () => {
    assert.equal(planHandoff({ config: config(), storedState: null, message: "hello there", sources: [], nowMs: OPEN }).plan, null);
    assert.equal(planHandoff({ config: config(), storedState: null, message: "how much is a root canal", sources: ["fees.md"], nowMs: OPEN }).plan, null);
    assert.equal(planHandoff({ config: config(), storedState: null, message: "scaling please", sources: [], collection: { state: "ask" }, nowMs: OPEN }).plan, null);
  });

  test("closed hours with a call-back request type switched on: the plan says so", () => {
    const r = planHandoff({ config: config(), storedState: null, message: "I want to speak to a person", nowMs: CLOSED });
    assert.deepEqual([r.plan.kind, r.plan.callback], ["unavailable", true]);
    assert.equal(r.result.kind, "unavailable");
    assert.equal(r.result.contacts, undefined, "no numbers leave for a transfer that cannot happen");
  });
});
