import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemInstruction,
  buildQueryRewriteInstruction,
  buildQueryRewriteInput,
  buildCollectionInstruction,
  buildHandoffInstruction,
} from "@/lib/agent/prompt";
import { PLACEHOLDER_BUSINESS_NAME } from "@/lib/tenant/config";

const config = (over = {}) => ({
  businessName: "Acme Dental",
  purpose: "We run a family dental clinic in Karachi.",
  tone: "friendly",
  timezone: "Asia/Karachi",
  hours: { mon: [["09:00", "17:00"]], sun: [] },
  replyLanguage: "en",
  capabilities: {},
  escalation: null,
  ...over,
});
const chunk = (n, over = {}) => ({
  sourceTitle: `Doc ${n}`,
  heading: `Heading ${n}`,
  content: `Content ${n}.`,
  ...over,
});
const build = (over = {}, { channel = "chat", chunks = [] } = {}) =>
  buildSystemInstruction({ config: config(over), channel, chunks });

describe("ABOUT THIS BUSINESS profile (§6.20)", () => {
  test("name, purpose and hours all appear, hours formatted per day", () => {
    const p = build();
    assert.match(p, /ABOUT THIS BUSINESS:\nName: Acme Dental\n/);
    assert.match(p, /What we do, in the business's own words: We run a family dental clinic in Karachi\./);
    assert.match(p, /Business hours \(timezone Asia\/Karachi\): mon 09:00-17:00; sun closed\./);
  });

  test("the grounding EXCEPTION is present exactly when the profile is", () => {
    assert.match(build(), /ABOUT THIS BUSINESS above is always available to you/);
    const bare = build({ businessName: PLACEHOLDER_BUSINESS_NAME, purpose: "", hours: null });
    assert.ok(!bare.includes("ABOUT THIS BUSINESS"), "placeholder name + no purpose + no hours → no block AND no exception");
    assert.match(bare, /GROUNDING RULE/, "the base grounding rule never goes away");
  });

  test("the exception stays narrow: restate only, never invent products or guess from the name", () => {
    const p = build();
    assert.match(p, /Restate only what it says/);
    assert.match(p, /never turn it into specific products, services, prices/);
    assert.match(p, /do not guess one from the business's name/);
  });

  test("name only → Name line and exception, but no invented 'what we do' line", () => {
    const p = build({ purpose: "  ", hours: null });
    assert.match(p, /Name: Acme Dental/);
    assert.ok(!p.includes("What we do"));
    assert.match(p, /ABOUT THIS BUSINESS above is always available/);
  });

  test("purpose or hours alone also make a profile, and a placeholder name is never shown as a name", () => {
    const purposeOnly = build({ businessName: PLACEHOLDER_BUSINESS_NAME, hours: null });
    assert.match(purposeOnly, /What we do/);
    assert.ok(!purposeOnly.includes("Name: "));
    const hoursOnly = build({ businessName: PLACEHOLDER_BUSINESS_NAME, purpose: "", hours: "Mon-Fri 9-5" });
    assert.match(hoursOnly, /Business hours \(timezone Asia\/Karachi\): Mon-Fri 9-5\./);
  });

  test("malformed hours degrade to a readable line instead of throwing", () => {
    assert.match(build({ hours: 42 }), /Business hours \(timezone Asia\/Karachi\): not specified\./);
    assert.match(build({ hours: { tue: "closed for lunch" } }), /tue closed/);
    assert.match(build({ hours: { wed: [["09:00", "12:00"], ["14:00", "18:00"]] } }), /wed 09:00-12:00, 14:00-18:00/);
  });

  test("with no retrieved chunks the model is told NOTHING is relevant — and the profile is still there", () => {
    const p = build();
    assert.match(p, /NOTHING IN THIS BUSINESS'S DOCUMENTS IS RELEVANT TO THIS QUESTION\./);
    assert.match(p, /ABOUT THIS BUSINESS:/);
  });
});

describe("conflict rule (documents that disagree)", () => {
  const RULE = /IF DOCUMENTS DISAGREE/;
  const ruleOf = (prompt) => prompt.split("\n\n").find((section) => section.startsWith("IF DOCUMENTS DISAGREE"));

  // The fixture of the bug report: test-docs 03 (149) and 08 (179), as retrieved.
  const priceSheet = { sourceTitle: "03-storepulse-pricing-plans.docx", heading: "StorePulse Pricing Plans > Pro Plan", content: "149 euro per month. Up to 5 stores.", sourceUpdatedAt: "2026-09-29T02:58:57Z" };
  const priceList = { sourceTitle: "08-storepulse-price-list-conflict.txt", heading: "Pro Plan", content: "179 euro per month. Up to 5 stores.", sourceUpdatedAt: "2026-09-29T02:59:05Z" };
  const priceSheetAgain = { ...priceSheet, heading: "StorePulse Pricing Plans > Pro", content: "149 euro/month" };

  test("included only when the passages come from TWO OR MORE DIFFERENT documents", () => {
    assert.ok(!RULE.test(build({}, { chunks: [] })));
    assert.ok(!RULE.test(build({}, { chunks: [chunk(1)] })));
    assert.ok(!RULE.test(build({}, { chunks: [chunk(1, { sourceTitle: "Same" }), chunk(2, { sourceTitle: "Same" })] })), "two passages of ONE document are not a disagreement between sources");
    assert.match(build({}, { chunks: [chunk(1), chunk(2)] }), RULE);
    assert.match(build({}, { chunks: [priceSheet, priceSheetAgain, priceList] }), RULE, "149 twice and 179 once is still a conflict, not a majority vote");
  });

  test("it asks for BOTH values, each with its document and date, and a team confirmation", () => {
    const rule = ruleOf(build({}, { chunks: [priceSheet, priceList] }));
    assert.match(rule, /give both values/);
    assert.match(rule, /do not pick one/);
    assert.match(rule, /which document each came from/);
    assert.match(rule, /the date it was updated/);
    assert.match(rule, /offer to have the team confirm/);
    assert.match(rule, /still give both and never average them/);
  });

  test("it is NOT a recency tie-break any more: recency may be mentioned, never used to drop a value", () => {
    const rule = ruleOf(build({}, { chunks: [priceSheet, priceList] }));
    assert.ok(!/prefer the one/i.test(rule));
    assert.match(rule, /You may say which is newer, but still give both/);
  });

  test("it does not fire on documents that merely repeat the same value — the rule itself says so", () => {
    const rule = ruleOf(build({}, { chunks: [priceSheet, priceList] }));
    assert.match(rule, /If the documents give the same value, just answer normally and say nothing about documents or any discrepancy/);
  });

  test("it sits AFTER the reference block and the grounding rule (recency), as the very last section", () => {
    const prompt = build({}, { chunks: [priceSheet, priceList] });
    assert.ok(prompt.indexOf("IF DOCUMENTS DISAGREE") > prompt.lastIndexOf("(document:"), "after every chunk");
    assert.ok(prompt.indexOf("IF DOCUMENTS DISAGREE") > prompt.indexOf("GROUNDING RULE"));
    assert.ok(prompt.trimEnd().endsWith(ruleOf(prompt)), "nothing follows it");
    // …also when the profile exception exists, which is appended before it
    const withProfile = build({ purpose: "We sell retail software." }, { chunks: [priceSheet, priceList] });
    assert.ok(withProfile.indexOf("IF DOCUMENTS DISAGREE") > withProfile.indexOf("ABOUT THIS BUSINESS above is always available"));
    assert.ok(withProfile.trimEnd().endsWith(ruleOf(withProfile)));
  });

  test("three sentences at most", () => {
    const rule = ruleOf(build({}, { chunks: [priceSheet, priceList] }));
    const sentences = rule.replace(/^IF DOCUMENTS DISAGREE:\s*/, "").split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(sentences.length <= 3, `${sentences.length} sentences`);
  });

  test("VOICE-SAFE: no markdown, bullets, digits, URLs, emoji or file names to read aloud", () => {
    const rule = ruleOf(build({}, { chunks: [priceSheet, priceList], channel: "voice" }));
    assert.ok(!/[*#•_`>]/.test(rule), "no markdown characters");
    assert.ok(!/\d/.test(rule), "no digits for the model to copy");
    assert.ok(!/https?:|www\.|\.(docx|txt|pdf|csv|md)\b/i.test(rule));
    assert.ok(!/\p{Extended_Pictographic}/u.test(rule));
    assert.match(rule, /plain name without the file extension/, "told to say a document by its plain name");
  });

  test("the rule text is identical on chat and voice (the behaviour must not drift per channel)", () => {
    const chunks = [priceSheet, priceList];
    assert.equal(ruleOf(buildSystemInstruction({ config: config(), channel: "chat", chunks })), ruleOf(buildSystemInstruction({ config: config(), channel: "voice", chunks })));
  });

  test("chunks are labelled as DOCUMENTS with title, section and update date", () => {
    const p = build({}, { chunks: [priceSheet, { ...priceList, heading: null, sourceUpdatedAt: undefined }] });
    assert.match(p, /\[1\] \(document: "storepulse pricing plans", section: StorePulse Pricing Plans > Pro Plan, updated 29 September 2026\)\n149 euro per month/);
    assert.match(p, /\[2\] \(document: "storepulse price list conflict"\)\n179 euro per month/, "no section, no date → bare document name");
  });

  test("with more than one document a NOTE above the passages says so; with one it does not", () => {
    const two = build({}, { chunks: [priceSheet, priceList] });
    assert.match(two, /NOTE: these passages come from 2 DIFFERENT documents, named in each label\. Different documents can state different values for the same thing\./);
    assert.ok(two.indexOf("NOTE: these passages") < two.indexOf("[1] (document:"), "before the first passage");
    assert.ok(!build({}, { chunks: [priceSheet, priceSheetAgain] }).includes("NOTE: these passages"));
    assert.match(build({}, { chunks: [priceSheet, priceSheetAgain, priceList] }), /come from 2 DIFFERENT documents/, "counts documents, not chunks");
  });

  test("the reference header names the business in capitals, and the grounding rule follows the material", () => {
    const p = build({}, { chunks: [chunk(1)] });
    assert.ok(p.includes("REFERENCE MATERIAL FROM ACME DENTAL:"));
    assert.ok(p.indexOf("GROUNDING RULE") > p.indexOf("REFERENCE MATERIAL"));
  });

  test("the update date is the DAY, written as it would be said — not as an ISO string to read aloud", () => {
    assert.match(build({}, { chunks: [chunk(1, { sourceUpdatedAt: "2026-03-04T23:59:59Z" })] }), /updated 4 March 2026\)/);
    assert.match(build({}, { chunks: [chunk(1, { sourceUpdatedAt: "2026-12-31T00:00:00Z" })] }), /updated 31 December 2026\)/, "UTC, so the server's time zone cannot move the day");
    assert.match(build({}, { chunks: [chunk(1, { sourceUpdatedAt: "not a date" })] }), /updated an unknown date\)/);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(build({}, { chunks: [chunk(1, { sourceUpdatedAt: "2026-03-04T10:00:00Z" })] })), "no ISO date anywhere in the prompt");
  });

  test("documents are labelled by what a person would call them — no file extension, no number prefix, no hyphens", () => {
    const p = build({}, { chunks: [{ ...priceSheet }, { ...priceList }] });
    assert.ok(!/\.(docx|txt)/.test(p.slice(p.indexOf("REFERENCE MATERIAL"))), "no file extension in the reference block");
    assert.ok(!p.includes("08-storepulse"));
  });

  test("two documents that would humanise to the SAME name keep their raw titles, so they stay distinguishable", () => {
    const p = build({}, { chunks: [chunk(1, { sourceTitle: "01-plans.md" }), chunk(2, { sourceTitle: "02-plans.md" })] });
    assert.match(p, /document: "01-plans\.md"/);
    assert.match(p, /document: "02-plans\.md"/);
  });
});

describe("language modes (§7)", () => {
  test("both languages are understood whichever one is answered in", () => {
    for (const replyLanguage of ["en", "ur"]) {
      const p = build({ replyLanguage });
      assert.match(p, /may write or speak English, Urdu \(in Urdu script or in Roman letters\), or a mix of both/);
      assert.match(p, /Understand all of it equally well/);
    }
  });

  test("the chosen language is the one answered in, whatever the customer used", () => {
    assert.match(build({ replyLanguage: "ur" }), /ALWAYS reply in Urdu, whatever language the customer used and even when the reference material below is in English/);
    assert.match(build({ replyLanguage: "en" }), /ALWAYS reply in English, whatever language the customer used and even when the reference material below is in Urdu/);
  });

  test("there is no mirror-the-customer mode and no Italian any more", () => {
    for (const replyLanguage of ["en", "ur", "auto", "it"]) {
      const p = build({ replyLanguage });
      assert.ok(!p.includes("THE SAME LANGUAGE THE CUSTOMER WROTE IN"), replyLanguage);
      assert.ok(!p.includes("Italian"), replyLanguage);
    }
  });

  test("an unknown or removed reply language falls back to English rather than naming 'undefined'", () => {
    for (const replyLanguage of ["xx", "auto", "it", undefined]) {
      const p = build({ replyLanguage });
      assert.match(p, /ALWAYS reply in English/);
      assert.ok(!p.includes("undefined"));
    }
  });

  test("Urdu replies are written in Urdu script, with loanwords in script; on a call numbers are words", () => {
    const chat = build({ replyLanguage: "ur" });
    assert.match(chat, /Write Urdu in Urdu script, never in Roman letters/);
    assert.match(chat, /everyday English loanwords/);
    assert.ok(!chat.includes("write numbers, prices and times as Urdu words"), "digits are fine in a chat window");
    assert.match(build({ replyLanguage: "ur" }, { channel: "voice" }), /write numbers, prices and times as Urdu words/);
    assert.ok(!build({ replyLanguage: "en" }, { channel: "voice" }).includes("Write Urdu in Urdu script"));
  });

  test("the INTERFACE locale never leaks into the prompt", () => {
    const p = build({ replyLanguage: "en", uiLocale: "ur" });
    assert.match(p, /ALWAYS reply in English/);
    assert.ok(!p.includes("ALWAYS reply in Urdu"));
  });

  test("on a call the model is told the transcript may be Urdu, English or both, in either script", () => {
    const p = build({ replyLanguage: "en" }, { channel: "voice" });
    assert.match(p, /HEARING:/);
    assert.match(p, /English words in Urdu script or Urdu words in Latin letters/);
  });
});

describe("channel style", () => {
  test("voice forbids markdown/lists/emoji/URLs because every word is spoken", () => {
    const p = build({}, { channel: "voice" });
    assert.match(p, /LIVE PHONE CALL/);
    assert.match(p, /Never output markdown, asterisks, bullet points, numbered lists, emoji or URLs/);
    assert.ok(!p.includes("chat window"));
  });

  test("chat is the default, including for an unknown channel", () => {
    assert.match(build({}, { channel: "chat" }), /You are in a chat window/);
    assert.match(build({}, { channel: "carrier-pigeon" }), /You are in a chat window/);
    assert.ok(!build({}, { channel: "chat" }).includes("LIVE PHONE CALL"));
  });

  test("tone falls back to professional", () => {
    assert.match(build({ tone: "concise" }), /TONE: Minimal\./);
    assert.match(build({ tone: "sarcastic" }), /TONE: Warm but businesslike\./);
  });
});

describe("capabilities and the TOOL_EXECUTION_AVAILABLE guard (§6.11)", () => {
  const caps = (ids) => Object.fromEntries(ids.map((id) => [id, { enabled: true }]));

  test("while tools do not execute, tool-backed capabilities get the 'never claim it is done' guard", () => {
    // If this fails because someone flipped TOOL_EXECUTION_AVAILABLE, that is the point:
    // flip it only after tools genuinely execute and log to agent_actions.
    const p = build({ capabilities: caps(["book_appointment", "check_order_status"]) });
    assert.match(p, /CRITICAL — you cannot yet complete these actions yourself: Book appointments, Check order status\./);
    assert.match(p, /NEVER say an action is done, booked, cancelled or processed/);
    assert.match(p, /Do not invent reference numbers, confirmation codes or times/);
  });

  test("conversational capabilities are described but not guarded", () => {
    const p = build({ capabilities: caps(["take_message", "collect_contact_info"]) });
    assert.match(p, /WHAT YOU CAN DO FOR THE CUSTOMER:/);
    assert.match(p, /TAKE A MESSAGE/);
    assert.ok(!p.includes("CRITICAL"));
  });

  test("the guard names only the tool-backed ones", () => {
    const p = build({ capabilities: caps(["take_message", "book_appointment"]) });
    const critical = p.split("\n\n").find((s) => s.startsWith("CRITICAL"));
    assert.match(critical, /Book appointments/);
    assert.ok(!critical.includes("Take a message"));
  });

  test("disabled, unknown and wrong-channel capabilities contribute nothing", () => {
    const p = build({ capabilities: { book_appointment: { enabled: false }, nonsense: { enabled: true }, take_message: { enabled: true, channels: ["voice"] } } });
    assert.ok(!p.includes("WHAT YOU CAN DO"));
    assert.ok(!p.includes("CRITICAL"));
  });

  test("tenant params override catalog defaults key by key", () => {
    const p = build({ capabilities: { book_appointment: { enabled: true, params: { slotMinutes: 45 } } } });
    assert.match(p, /Appointments are 45 minutes and can be booked up to 30 days ahead/);
  });

  test("a capability can speak differently per channel", () => {
    const chat = build({ capabilities: caps(["collect_contact_info"]) }, { channel: "chat" });
    const voice = build({ capabilities: caps(["collect_contact_info"]) }, { channel: "voice" });
    assert.match(chat, /Repeat the details back once/);
    assert.match(voice, /digit by digit/);
  });
});

describe("escalation (human handoff)", () => {
  const handoff = { enabled: true, contacts: [{ id: "c1", role: "Senior doctor", name: "Dr Ayesha", phone: "+923001234567" }] };

  test("when handoff is on, the model is told it cannot transfer anyone itself", () => {
    const p = build({ escalation: handoff });
    assert.match(p, /PASSING THE CALLER TO A PERSON: you cannot transfer anyone yourself/);
    assert.match(p, /never read out a phone number/);
    assert.match(p, /connect me to a person/);
  });

  test("phone numbers are never handed to the model to read out", () => {
    const p = build({ escalation: handoff });
    assert.ok(!p.includes("+923001234567"));
    assert.ok(!p.includes("0300 1234567"));
  });

  test("off, or on with nobody to hand to: no section at all", () => {
    assert.ok(!build({ escalation: { enabled: false, contacts: handoff.contacts } }).includes("PASSING THE CALLER"));
    assert.ok(!build({ escalation: { enabled: true, contacts: [] } }).includes("PASSING THE CALLER"));
    assert.ok(!build({ escalation: null }).includes("PASSING THE CALLER"));
  });
});

describe("buildHandoffInstruction — the model words what the system decided", () => {
  test("rephrase: say so honestly, ask for another way, no mention of a person", () => {
    const text = buildHandoffInstruction({ kind: "rephrase" }, { channel: "voice" });
    assert.match(text, /could not make out/);
    assert.match(text, /put it another way/);
    assert.match(text, /Do not mention a person or a transfer/);
  });

  test("handoff: the model only acknowledges — the code adds the announcement — no number, no goodbye on a call", () => {
    const plan = { kind: "handoff", reason: "asked", contact: { role: "Senior doctor", name: "Dr Ayesha" } };
    const voice = buildHandoffInstruction(plan, { channel: "voice" });
    assert.match(voice, /being connected to our Senior doctor, Dr Ayesha right now/);
    assert.match(voice, /added automatically RIGHT AFTER your reply/);
    assert.match(voice, /do NOT say that you are connecting or transferring them, do NOT name the person/);
    assert.match(voice, /do not say goodbye/);
    assert.match(voice, /do not give a phone number/);
    assert.doesNotMatch(buildHandoffInstruction(plan, { channel: "chat" }), /do not say goodbye/);
  });

  test("each reason has its own opening", () => {
    const base = { kind: "handoff", contact: { role: "Manager", name: "" } };
    assert.match(buildHandoffInstruction({ ...base, reason: "asked" }, { channel: "chat" }), /asked for a person/);
    assert.match(buildHandoffInstruction({ ...base, reason: "frustrated" }, { channel: "chat" }), /apologise briefly/);
    assert.match(buildHandoffInstruction({ ...base, reason: "topic" }, { channel: "chat" }), /wants a person to handle/);
    assert.match(buildHandoffInstruction({ ...base, reason: "not_understood" }, { channel: "chat" }), /could not understand or help/);
    assert.match(buildHandoffInstruction({ ...base, reason: "asked" }, { channel: "chat" }), /our Manager/);
  });

  test("unavailable: never claims a transfer, offers a call-back only when the business takes them", () => {
    const withCallback = buildHandoffInstruction({ kind: "unavailable", callback: true }, { channel: "voice" });
    assert.match(withCallback, /closed right now/);
    assert.match(withCallback, /call them back/);
    assert.match(withCallback, /Do not say you are connecting them/);
    assert.doesNotMatch(buildHandoffInstruction({ kind: "unavailable", callback: false }, { channel: "voice" }), /call them back/);
  });

  test("no plan, no section; an unknown kind adds nothing", () => {
    assert.equal(buildHandoffInstruction(null, { channel: "chat" }), null);
    assert.equal(buildHandoffInstruction({ kind: "nope" }, { channel: "chat" }), null);
  });

  test("the plan is placed in the system instruction", () => {
    const p = buildSystemInstruction({
      config: { businessName: "Acme", tone: "professional", replyLanguage: "en", escalation: { enabled: true, contacts: [{ role: "Manager", name: "Bilal", phone: "+923001234567" }] } },
      channel: "voice",
      handoff: { kind: "handoff", reason: "asked", contact: { role: "Manager", name: "Bilal" } },
    });
    assert.match(p, /PASSING THE CALLER ON: The caller asked for a person\./);
    assert.ok(!p.includes("+923001234567"));
  });
});

describe("how the agent helps — solution-oriented and never hurried", () => {
  test("every prompt carries both halves of the rule, on chat and on a call", () => {
    for (const channel of ["chat", "voice"]) {
      const p = buildSystemInstruction({ config: { businessName: "Acme", tone: "professional", replyLanguage: "en" }, channel });
      assert.match(p, /HOW YOU HELP: Be solution-oriented/);
      assert.match(p, /never rush, hurry, interrupt or talk down to anyone/);
      assert.match(p, /ask once whether there is anything else/);
    }
  });
});

describe("the request-start marker in the prompt is a real code", () => {
  test("it is spelled out per request type, never as a placeholder", () => {
    const p = buildCollectionInstruction(
      { state: "idle", language: "en", offers: [{ type: "appointment", label: "Appointment", firstQuestion: "May I have your name?" }, { type: "callback", label: "Callback", firstQuestion: "May I have your name?" }] },
      { channel: "voice" }
    );
    assert.match(p, /\[\[START appointment\]\] for Appointment, \[\[START callback\]\] for Callback/);
    assert.doesNotMatch(p, /START code/);
    assert.doesNotMatch(p, /\(code /);
  });
});

describe("identity", () => {
  test("speaks as the business and never names the technology", () => {
    const p = build();
    assert.match(p, /You are the AI assistant for Acme Dental\./);
    assert.match(p, /say 'we' and 'our'/);
    assert.match(p, /never name the technology behind you/);
  });
});

describe("query-rewrite prompts (§6.19)", () => {
  test("the instruction keeps the customer's language, forbids new facts, and returns standalone messages unchanged", () => {
    const s = buildQueryRewriteInstruction();
    assert.match(s, /SAME LANGUAGE AND SCRIPT as the customer's latest message: English stays English, Urdu stays Urdu, Roman Urdu stays Roman Urdu, a mix stays a mix\. Never translate/);
    assert.match(s, /Do NOT add prices, numbers, policies or product details/);
    assert.match(s, /return it EXACTLY as written/);
    assert.match(s, /Output ONLY the search query/);
  });

  test("the input labels roles, clips long turns to 400 chars and ends with the cue", () => {
    const long = "word ".repeat(200);
    const out = buildQueryRewriteInput({
      history: [{ role: "user", content: "How much is Pro?" }, { role: "assistant", content: long }],
      message: "and Growth?",
    });
    assert.match(out, /^CONVERSATION SO FAR:\nCustomer: How much is Pro\?\nAssistant: word word/);
    assert.match(out, /LATEST CUSTOMER MESSAGE:\nand Growth\?\n\nSTANDALONE SEARCH QUERY:$/);
    const assistantLine = out.split("\n").find((l) => l.startsWith("Assistant:"));
    assert.ok(assistantLine.endsWith("…"));
    assert.ok(assistantLine.length <= "Assistant: ".length + 401);
  });
});

describe("the request plan: saved first, read back after", () => {
  const lines = [
    { id: "name", label: "Name", display: "Ahmed", type: "text" },
    { id: "phone", label: "Phone number", display: "0300 1234567", type: "phone" },
  ];
  const saved = { state: "saved", language: "en", type: "appointment", typeLabel: "Appointment", reference: "AP-4K7Q2", lines, corrected: [], justSaved: true };

  test("a request saved this turn is announced, with its number in chat and without it on a call", () => {
    const chat = buildCollectionInstruction(saved, { channel: "chat" });
    assert.match(chat, /just been SAVED with the request number AP-4K7Q2/);
    assert.match(chat, /Give the request number AP-4K7Q2/);
    assert.match(chat, /ask whether everything is correct/);
    const voice = buildCollectionInstruction(saved, { channel: "voice" });
    assert.match(voice, /Do not read the request number aloud/);
    assert.match(voice, /say it digit by digit/);
  });

  test("it never claims the request is booked or confirmed", () => {
    for (const plan of [saved, { ...saved, justSaved: false }, { state: "closed", language: "en", type: "appointment", typeLabel: "Appointment", reference: "AP-4K7Q2" }]) {
      assert.match(buildCollectionInstruction(plan, { channel: "chat" }), /never say it is\s+booked/);
    }
  });

  test("an optional question after the save does not announce the save a second time", () => {
    const ask = { state: "ask", language: "en", type: "appointment", typeLabel: "Appointment", collected: lines, ask: { label: "Anything else", question: "Anything else?", required: false }, saved: { reference: "AP-4K7Q2", justSaved: false } };
    assert.match(buildCollectionInstruction(ask, { channel: "chat" }), /do not announce it again/);
    assert.match(buildCollectionInstruction({ ...ask, saved: { reference: "AP-4K7Q2", justSaved: true } }, { channel: "chat" }), /just been SAVED/);
  });

  test("a correction is acknowledged only when the row really was updated", () => {
    const fixed = buildCollectionInstruction({ ...saved, justSaved: false, corrected: [lines[1]] }, { channel: "chat" });
    assert.match(fixed, /Say you have updated it/);
    const failed = buildCollectionInstruction({ ...saved, justSaved: false, corrected: [lines[1]], updateFailed: true }, { channel: "chat" });
    assert.match(failed, /could NOT be updated/);
    assert.doesNotMatch(failed, /Say you have updated it/);
  });

  test("withdrawing and a failed update say what happened and nothing more", () => {
    assert.match(buildCollectionInstruction({ state: "withdrawn", language: "en", typeLabel: "Appointment", reference: "AP-4K7Q2" }, { channel: "chat" }), /withdrew their request.*cancelled/);
    assert.match(buildCollectionInstruction({ state: "update_failed", language: "en", typeLabel: "Appointment" }, { channel: "chat" }), /do not claim it was changed/);
  });
});
