import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { announcementFor, nextContactLine, normalizeAnnounce, announceProblems, ANNOUNCE_MAX_CHARS } from "@/lib/handoff/announce";
import { normalizeHandoffConfig, validateHandoffConfig } from "@/lib/handoff/config";

// The line said before every transfer is the CODE's (CLAUDE.md §6.26): a real call was put
// through in silence because the model greeted the caller instead of announcing the transfer.

const ALI = { id: "c1", role: "Representative", name: "Ali", phone: "+923001234567" };
const ADAN = { id: "c2", role: "Senior", name: "Adan", phone: "+923211234567" };

describe("the built-in line", () => {
  test("names the person and their role, in English and Urdu", () => {
    assert.equal(announcementFor({ escalation: null, contact: ALI, language: "en" }), "I'm connecting you to Ali, our Representative. Please stay on the line.");
    assert.equal(announcementFor({ escalation: {}, contact: ADAN, language: "en" }), "I'm connecting you to Adan, our Senior. Please stay on the line.");
    assert.equal(announcementFor({ escalation: null, contact: ALI, language: "ur" }), "آپ کی بات Ali سے کروائی جا رہی ہے، جو ہمارے Representative ہیں۔ براہِ کرم لائن پر رہیے۔");
  });

  test("a person with only a name, or only a role, still gets a natural sentence", () => {
    assert.equal(announcementFor({ escalation: null, contact: { name: "Ali" }, language: "en" }), "I'm connecting you to Ali. Please stay on the line.");
    assert.equal(announcementFor({ escalation: null, contact: { role: "Senior doctor" }, language: "en" }), "I'm connecting you to our Senior doctor. Please stay on the line.");
    assert.equal(announcementFor({ escalation: null, contact: {}, language: "en" }), "I'm connecting you to a member of our team. Please stay on the line.");
    assert.equal(announcementFor({ escalation: null, contact: { role: "ڈاکٹر" }, language: "ur" }), "آپ کی بات ہمارے ڈاکٹر سے کروائی جا رہی ہے۔ براہِ کرم لائن پر رہیے۔");
  });

  test("any language other than Urdu is spoken in English", () => {
    assert.match(announcementFor({ escalation: null, contact: ALI, language: "it" }), /^I'm connecting you to Ali/);
  });
});

describe("the owner's own line", () => {
  const escalation = { announce: { en: "Please hold, {name} from our {role} team will be right with you.", ur: "{name} سے بات کروائی جا رہی ہے۔" } };

  test("is filled in for each person", () => {
    assert.equal(announcementFor({ escalation, contact: ALI, language: "en" }), "Please hold, Ali from our Representative team will be right with you.");
    assert.equal(announcementFor({ escalation, contact: ADAN, language: "en" }), "Please hold, Adan from our Senior team will be right with you.");
    assert.equal(announcementFor({ escalation, contact: ALI, language: "ur" }), "Ali سے بات کروائی جا رہی ہے۔");
  });

  test("a missing name or role is stood in for, and no stray punctuation is left", () => {
    assert.equal(announcementFor({ escalation, contact: { role: "Senior" }, language: "en" }), "Please hold, our Senior from our Senior team will be right with you.");
    assert.equal(announcementFor({ escalation: { announce: { en: "Connecting you to {name}, {role}." } }, contact: { name: "Ali" }, language: "en" }), "Connecting you to Ali, team member.");
  });

  test("only the language with no own line falls back to the built-in one", () => {
    const onlyUrdu = { announce: { ur: "{name} سے بات کروائی جا رہی ہے۔" } };
    assert.match(announcementFor({ escalation: onlyUrdu, contact: ALI, language: "en" }), /^I'm connecting you to Ali, our Representative\./);
  });
});

describe("when the first person does not answer", () => {
  test("the caller is told, and the next person is announced", () => {
    assert.equal(nextContactLine({ escalation: null, previous: ALI, contact: ADAN, language: "en" }), "Ali isn't available right now. I'm connecting you to Adan, our Senior. Please stay on the line.");
    assert.match(nextContactLine({ escalation: null, previous: ALI, contact: ADAN, language: "ur" }), /^Ali اس وقت دستیاب نہیں ہیں۔ آپ کی بات Adan سے/);
    assert.match(nextContactLine({ escalation: null, previous: { role: "Representative" }, contact: ADAN, language: "en" }), /^Our Representative isn't available right now\./);
    assert.match(nextContactLine({ escalation: null, previous: {}, contact: ADAN, language: "en" }), /^That person isn't available right now\./);
  });
});

describe("saving and reading the setting", () => {
  test("stored lines are trimmed, unknown languages and empty lines dropped, never throws", () => {
    assert.deepEqual(normalizeAnnounce({ en: "  Hold   on, {name}.  ", ur: "", it: "x" }), { en: "Hold on, {name}." });
    assert.deepEqual(normalizeAnnounce("text"), {});
    assert.deepEqual(normalizeAnnounce(null), {});
    assert.equal(normalizeAnnounce({ en: "x".repeat(500) }).en.length, ANNOUNCE_MAX_CHARS);
  });

  test("a save is refused only when the line could not be spoken as meant", () => {
    assert.deepEqual(announceProblems(undefined), []);
    assert.deepEqual(announceProblems({ en: "", ur: null }), []);
    assert.deepEqual(announceProblems({ en: "Connecting you to {name}, our {role}." }), []);
    assert.deepEqual(announceProblems("hello"), [{ code: "announceInvalid" }]);
    assert.deepEqual(announceProblems({ fr: "Bonjour" }), [{ code: "announceInvalid" }]);
    assert.deepEqual(announceProblems({ en: 5 }), [{ code: "announceInvalid" }]);
    assert.deepEqual(announceProblems({ en: "x".repeat(ANNOUNCE_MAX_CHARS + 1) }), [{ code: "announceTooLong", vars: { max: ANNOUNCE_MAX_CHARS } }]);
    // {business} or a typo would be read out to the caller literally.
    assert.deepEqual(announceProblems({ en: "Connecting you to {nmae}." }), [{ code: "announcePlaceholder", vars: { value: "{nmae}", allowed: "{name} {role}" } }]);
  });

  test("the forwarding settings carry the line through, and refuse a bad one", () => {
    const contacts = [{ role: "Representative", name: "Ali", phone: "0300 1234567" }];
    assert.deepEqual(normalizeHandoffConfig({ enabled: true, contacts, announce: { en: " Hi {name} " } }).announce, { en: "Hi {name}" });
    assert.deepEqual(normalizeHandoffConfig({ enabled: true, contacts }).announce, {});
    const bad = validateHandoffConfig({ enabled: true, contacts, announce: { en: "To {business}" } });
    assert.equal(bad.ok, false);
    assert.equal(bad.problems[0].code, "announcePlaceholder");
    assert.equal(validateHandoffConfig({ enabled: true, contacts, announce: { ur: "{name} سے بات کروائی جا رہی ہے۔" } }).ok, true);
  });
});
