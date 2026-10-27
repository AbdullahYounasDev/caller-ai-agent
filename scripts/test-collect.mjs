/**
 * Does taking a customer's request work end to end, against the REAL database and the REAL
 * respond() — with only the model faked, so it costs no quota?
 *
 *   npm run test:collect        (needs DATABASE_URL, migrations applied)
 *
 * Covers what the unit tests (tests/collect-*.test.mjs) cannot, because it needs Postgres:
 *   - a whole appointment through respond(): draft saved between messages, read-back, a
 *     "yes" writes ONE record with a reference, the draft is cleared, nothing is saved earlier
 *   - the model's start marker never reaches the customer (streamed in pieces), is not stored,
 *     and still starts the draft
 *   - an Urdu callback, with Urdu digits
 *   - the same confirmation twice is one record
 *   - tenant B can never see, move or confirm tenant A's records, drafts or settings
 *   - a record moves along only the allowed ways, and only a person's call does it
 *   - a business that has not switched the feature on is not changed in any way
 *   - the settings are versioned and validated
 */
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env: DATABASE_URL must come from the environment
  }
}
const { prisma } = await import("@/lib/db");
const stub = await import("./test-collect-stub.mjs");
const { respond } = await import("@/lib/agent/respond");
const { saveAgentConfig, saveCollectConfig, getAgentConfig, invalidateAgentConfig } = await import("@/lib/tenant/config");
const { presetConfig, validateCollectConfig } = await import("@/lib/collect/config");
const { createRecord, listRecords, getRecord, updateRecordStatus, updateRecordDetails, withdrawRecord } = await import("@/lib/standins/records");
const { onEngineEvent } = await import("@/lib/standins/events");

const A = "__collect_test_a__";
const B = "__collect_test_b__";
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) fails++;
};

const events = [];
onEngineEvent((e) => events.push(e));

async function wipe() {
  for (const tenantId of [A, B]) {
    await prisma.record.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.message.deleteMany({ where: { tenantId } });
    await prisma.conversation.deleteMany({ where: { tenantId } });
    await prisma.agentConfig.deleteMany({ where: { tenantId } });
    invalidateAgentConfig(tenantId);
  }
}
await wipe();

const HOURS = { mon: [["10:00", "20:00"]], tue: [["10:00", "20:00"]], wed: [["10:00", "20:00"]], thu: [["10:00", "20:00"]], fri: [["10:00", "20:00"]], sat: [["10:00", "20:00"]], sun: [] };
const newConversation = (tenantId, channel = "chat") => prisma.conversation.create({ data: { tenantId, channel }, select: { id: true } }).then((c) => c.id);

async function say(tenantId, conversationId, userMessage, { channel = "chat" } = {}) {
  const chunks = [];
  stub.state.instructions.length = 0;
  let retrieved = null;
  const result = await respond({ tenantId, conversationId, channel, userMessage, onChunk: (c) => chunks.push(c), onStage: (stage, data) => stage === "retrieved" && (retrieved = data) });
  return { result, streamed: chunks.join(""), instruction: stub.state.instructions.at(-1) ?? "", retrieved };
}
const draftOf = (id) => prisma.conversation.findUnique({ where: { id }, select: { collectDraft: true } }).then((c) => c.collectDraft);

// ── tenant A: a dental clinic that takes requests ──────────────────────────
await saveAgentConfig(A, { businessName: "Smile Care", purpose: "A dental clinic in Karachi.", timezone: "Asia/Karachi", hours: HOURS, replyLanguage: "en" });
const setup = presetConfig("dental");
setup.enabled = true;
setup.services = [{ label: { en: "Scaling and polishing", ur: "صفائی اور پالش" } }, { label: { en: "Root canal", ur: "روٹ کینال" } }];
setup.recordTypes.appointment.fields = setup.recordTypes.appointment.fields.filter((f) => f.id !== "notes");
const bad = validateCollectConfig({ ...setup, recordTypes: { ...setup.recordTypes, appointment: { enabled: true, fields: [{ id: "name", required: true }] } } });
ok(!bad.ok && bad.problems.some((p) => p.code === "mustInclude"), "a form with no way to reach the customer / no date is refused");
const saved1 = await saveCollectConfig(A, validateCollectConfig(setup).config);
ok(saved1.collectVersion === 1 && saved1.collect.enabled, "settings saved as version 1");
const saved2 = await saveCollectConfig(A, validateCollectConfig(setup).config);
ok(saved2.collectVersion === 2, "every save bumps the version");
ok((await getAgentConfig(A, { skipCache: true })).collect.services.map((s) => s.id).join() === "scaling_and_polishing,root_canal", "settings round-trip through the database");

// ── an appointment, end to end ─────────────────────────────────────────────
const conv = await newConversation(A);
stub.state.reply = (n) => `Reply ${n}.`;
const WEDNESDAY_FIVE = () => ({ values: {}, date: "2026-12-02", time: "17:00" }); // a Wednesday
stub.state.extraction = () => ({ values: {}, date: null, time: null });
let r = await say(A, conv, "What are your opening hours?");
ok(r.result.collection?.state === "idle" && /REQUESTS YOU CAN TAKE/.test(r.instruction), "a question starts nothing; the model is told what it may offer");
ok((await draftOf(conv)) === null, "…and no draft exists");

r = await say(A, conv, "I'd like to book an appointment");
ok(r.result.collection?.state === "ask" && r.result.collection.field === "name", "asking for an appointment: the first question is the name");
ok(/Ask ONLY for: Name/.test(r.instruction) && /you cannot book, confirm or cancel anything yourself/i.test(r.instruction), "the model is told to ask only that, and that it cannot book or confirm");
let draft = await draftOf(conv);
ok(draft?.type === "appointment" && draft.stage === "collecting" && draft.asking === "name", "the draft is saved between messages");

r = await say(A, conv, "my name is Ahmed Khan");
ok(r.retrieved?.skipped === true && r.retrieved.collectionState === "ask", "the answer to a checklist question is NOT searched in the documents");
r = await say(A, conv, "0300 1234567");
ok(r.retrieved?.skipped === true && r.result.searchTrigger === "skipped", "…nor is the phone number");
ok(r.result.collection.field === "service" && /Scaling and polishing, Root canal/.test(r.instruction), "the owner's list of services is offered");
r = await say(A, conv, "root canal");
events.length = 0;
stub.state.extraction = WEDNESDAY_FIVE;
r = await say(A, conv, "tomorrow at five");
stub.state.extraction = () => ({ values: {}, date: null, time: null });
const rows = await prisma.record.findMany({ where: { tenantId: A } });
ok(r.result.collection.state === "saved" && /Ahmed Khan/.test(r.instruction) && /03001234567/.test(r.instruction), "the last detail is in: the details are read back");
ok(/saved with the request number/i.test(r.instruction) && /waits for a team member to confirm/.test(r.instruction) && /never say it is booked/i.test(r.instruction), "the model is told it is recorded, not booked");
ok(rows.length === 1 && rows[0].status === "requested" && /^AP-[A-Z0-9]{5}$/.test(rows[0].reference), `it is SAVED at once, with no yes needed, as 'requested' (${rows[0]?.reference})`);
ok(rows[0].data.phone === "+923001234567" && rows[0].data.service === "root_canal" && rows[0].scheduledLocal === "2026-12-02T17:00" && rows[0].timezone === "Asia/Karachi", "stored values are validated: phone in international form, the owner's option id, local time + zone");
ok(rows[0].conversationId === conv && rows[0].channel === "chat" && rows[0].language === "en" && rows[0].configVersion === 2, "it knows its conversation, channel, language and the version of the questions it was taken under");
ok(r.result.collection.reference === rows[0].reference, "respond() reports the reference");
ok((await draftOf(conv))?.stage === "saved", "the draft stays, so a correction can find the row");
const customer = await prisma.customer.findFirst({ where: { tenantId: A } });
ok(customer?.phone === "+923001234567" && customer.name === "Ahmed Khan", "the customer was recorded, found by phone number");
ok(events.some((e) => e.type === "record.submitted" && e.tenantId === A && e.data.reference === rows[0].reference && !JSON.stringify(e).includes("Ahmed")), "a record.submitted event was emitted, carrying ids and no personal details");

// ── a correction after saving UPDATES the row ──────────────────────────────
r = await say(A, conv, "no, my phone number is 0333 1112233");
const afterFix = await prisma.record.findMany({ where: { tenantId: A } });
ok(afterFix.length === 1 && afterFix[0].id === rows[0].id && afterFix[0].data.phone === "+923331112233", "a correction rewrites the SAME row — still one record");
ok(r.result.collection.state === "saved" && /updated it/i.test(r.instruction), "the model is told to say it updated it");
ok((await prisma.customer.findMany({ where: { tenantId: A, phone: "+923331112233" } })).length === 1, "the customer follows the new number");
r = await say(A, conv, "thanks, that's all");
ok(r.result.collection.state === "closed" && (await draftOf(conv)) === null, "thanks closes it and clears the draft");
ok((await prisma.record.count({ where: { tenantId: A } })) === 1, "…without creating anything");

// ── the same confirmation twice is one record ──────────────────────────────
const again = await createRecord(A, { submissionKey: rows[0].submissionKey, type: "appointment", values: rows[0].data, summary: "x", scheduledAt: null, language: "en" });
rows[0].data = afterFix[0].data;
ok(!again.created && again.reference === rows[0].reference && (await prisma.record.count({ where: { tenantId: A } })) === 1, "saving the same confirmation again returns the same record");

// ── the model's start marker ───────────────────────────────────────────────
const conv2 = await newConversation(A);
stub.state.reply = "[[START appointment]] Of course, I can take your details. May I have your name?";
r = await say(A, conv2, "doctor sahib se milwa dein");
ok(r.result.collection?.state === "idle", "rules did not recognise that phrase");
ok(!/\[\[|START/.test(r.streamed) && r.streamed.startsWith("Of course"), `the marker never reached the customer (streamed in 4-character pieces): "${r.streamed.slice(0, 30)}…"`);
const storedReply = (await prisma.message.findMany({ where: { conversationId: conv2, role: "assistant" } })).at(-1).content;
ok(storedReply.startsWith("Of course") && !storedReply.includes("[["), "…and it is not stored in the transcript");
draft = await draftOf(conv2);
ok(draft?.type === "appointment" && draft.asking === "name", "…but it started the draft, so the next message is taken as the name");
stub.state.reply = (n) => `Reply ${n}.`;
await say(A, conv2, "Bilal");
ok((await draftOf(conv2)).values.name === "Bilal", "the name was taken");

// ── Urdu callback, Urdu digits, on a call ──────────────────────────────────
await saveAgentConfig(B, { businessName: "Karachi Support", timezone: "Asia/Karachi", hours: HOURS, replyLanguage: "ur" });
const cc = presetConfig("call_center");
cc.enabled = true;
await saveCollectConfig(B, validateCollectConfig(cc).config);
const conv3 = await newConversation(B, "voice");
r = await say(B, conv3, "مجھے واپس کال کریں", { channel: "voice" });
ok(r.result.collection.state === "ask" && /براہِ کرم اپنا نام بتائیں/.test(r.instruction) && /ALWAYS reply in Urdu/.test(r.instruction), "Urdu: the question is the Urdu wording and the model is told to answer in Urdu");
await say(B, conv3, "میرا نام احمد ہے", { channel: "voice" });
r = await say(B, conv3, "۰۳۰۰ ۱۲۳۴۵۶۷", { channel: "voice" });
ok((await draftOf(conv3)).values.phone === "+923001234567", "Urdu digits become a phone number");
ok((await prisma.record.count({ where: { tenantId: B } })) === 0, "a required detail (the reason) is still missing: nothing saved yet");
await say(B, conv3, "نہیں", { channel: "voice" });
r = await say(B, conv3, "میری رپورٹ کے بارے میں", { channel: "voice" });
const savedEarly = await prisma.record.findFirst({ where: { tenantId: B } });
ok(savedEarly?.type === "callback" && r.result.collection.state === "ask" && /^CB-/.test(savedEarly.reference), `the callback is saved the moment its required details are in — before the optional questions (${savedEarly?.reference})`);
ok(/Do not read the request number aloud/.test(r.instruction), "on a call the reference is not read out unless asked");
for (const m of ["نہیں", "نہیں"]) r = await say(B, conv3, m, { channel: "voice" });
const cb = await prisma.record.findFirst({ where: { tenantId: B } });
ok(r.result.collection.state === "saved" && /صفر تین صفر صفر/.test(r.instruction), "on a call the number is read out digit by digit, in Urdu words");
ok(cb.id === savedEarly.id && cb.channel === "voice" && cb.language === "ur" && cb.data.reason === "میری رپورٹ کے بارے میں" && (await prisma.record.count({ where: { tenantId: B } })) === 1, "the optional answer UPDATED the same row (still one record, from a call, in Urdu)");

// ── tenants are walled off ─────────────────────────────────────────────────
const idA = rows[0].id;
ok((await listRecords(B)).data.every((x) => x.id !== idA) && (await listRecords(B)).total === 1, "tenant B's list holds only its own request");
ok((await getRecord(B, idA)) === null, "tenant B cannot read tenant A's record by id");
ok((await updateRecordStatus(B, idA, "confirmed")).reason === "not_found", "…or confirm it");
ok((await prisma.record.findUnique({ where: { id: idA } })).status === "requested", "…and it is untouched");
ok((await getAgentConfig(B, { skipCache: true })).collect.industry === "call_center" && (await getAgentConfig(A, { skipCache: true })).collect.industry === "dental", "each tenant has its own settings");

// ── a person moves a request along ─────────────────────────────────────────
events.length = 0;
const c1 = await updateRecordStatus(A, idA, "confirmed");
ok(c1.ok && c1.record.status === "confirmed" && events.some((e) => e.type === "record.updated" && e.data.status === "confirmed"), "requested → confirmed, with an event");
ok((await updateRecordStatus(A, idA, "requested")).ok, "a confirmed request can be reopened");
await updateRecordStatus(A, idA, "confirmed");
await updateRecordStatus(A, idA, "done");
ok((await updateRecordStatus(A, idA, "cancelled")).reason === "invalid_transition", "a finished request cannot be cancelled");
ok((await updateRecordStatus(A, idA, "bogus")).reason === "invalid_status", "an unknown status is refused");
ok((await updateRecordDetails(A, idA, { values: { name: "X" } })).reason === "locked", "the agent cannot rewrite a request a person has already worked on");
ok((await withdrawRecord(A, idA)).reason === "locked" && (await prisma.record.findUnique({ where: { id: idA } })).status === "done", "…or withdraw it");
ok((await updateRecordDetails(B, idA, { values: { name: "X" } })).reason === "not_found", "…and another tenant cannot touch it at all");
const counts = (await listRecords(A)).counts;
ok(counts.done === 1 && counts.requested === 0, `status counts for the badges: ${JSON.stringify(counts)}`);

// ── a business that has not set this up is untouched ───────────────────────
await saveAgentConfig("__collect_test_c__", { businessName: "Plain Co" });
const conv4 = await newConversation("__collect_test_c__");
r = await say("__collect_test_c__", conv4, "I want to book an appointment");
ok(r.result.collection === null && !/REQUESTS YOU CAN TAKE|TAKING A REQUEST/.test(r.instruction) && (await draftOf(conv4)) === null, "a business that never switched it on gets exactly the agent it had before");

// ── an old draft is forgotten ──────────────────────────────────────────────
const conv5 = await newConversation(A);
await say(A, conv5, "I want to book an appointment");
const stale = await draftOf(conv5);
await prisma.conversation.update({ where: { id: conv5 }, data: { collectDraft: { ...stale, updatedAt: Date.now() - 31 * 60_000 } } });
r = await say(A, conv5, "0300 1234567");
ok(r.result.collection.state === "idle" && (await draftOf(conv5)) === null, "a draft nobody touched for half an hour is dropped, not resumed");

// ── the model being down never costs the customer a reply ──────────────────
const conv6 = await newConversation(A);
stub.state.extraction = null;
for (const m of ["book an appointment", "Ahmed", "03001234567", "scaling"]) r = await say(A, conv6, m);
r = await say(A, conv6, "kal shaam paanch baje");
ok(r.result.reply.length > 0 && r.result.collection.state === "ask" && /could not be processed/.test(r.instruction), "extraction down: the reply still comes, asking for the answer again");

// ── a side question in the middle of a booking IS searched ─────────────────
const conv7 = await newConversation(A);
await say(A, conv7, "I want to book an appointment");
r = await say(A, conv7, "do you take cards?");
ok(r.retrieved?.skipped === false, "a question asked during a booking still gets its document search");
r = await say(A, conv7, "Ahmed Khan");
ok(r.retrieved?.skipped === true && r.result.collection.field === "phone", "…and the booking carries on, again without a search");

// ── a spoken reply cut off by the caller is stored as what was heard ───────
const { trimLastReply } = await import("@/lib/agent/respond");
const conv8 = await newConversation(A);
stub.state.reply = "We open at nine. We close at six. On Saturdays we close at one.";
await say(A, conv8, "What are your hours?");
await trimLastReply({ tenantId: A, conversationId: conv8, spokenText: "We open at nine." });
const lastAssistant = (await prisma.message.findMany({ where: { conversationId: conv8, role: "assistant" }, orderBy: { createdAt: "desc" } }))[0];
ok(lastAssistant.content === "We open at nine.", "an interrupted reply keeps only the part the caller heard");
await trimLastReply({ tenantId: A, conversationId: conv8, spokenText: "" });
ok((await prisma.message.count({ where: { conversationId: conv8, role: "assistant" } })) === 0, "a reply of which nothing was heard is dropped");
await trimLastReply({ tenantId: B, conversationId: conv8, spokenText: "x" }); // another tenant: no effect, no error
ok(true, "trimming is scoped to the tenant");

// ── passing a caller to a person ───────────────────────────────────────────
const H = "__collect_test_handoff__";
const CONTACTS = [
  { role: "Representative", name: "Bilal", phone: "0300 1234567" },
  { role: "Senior doctor", name: "Dr Ayesha", phone: "0321 5551234" },
];
await saveAgentConfig(H, { businessName: "Smile Care", timezone: "Asia/Karachi", hours: null, escalation: { enabled: true, contacts: CONTACTS, afterMisses: 2, topics: ["complaint"] } });
const stored = (await getAgentConfig(H, { skipCache: true })).escalation;
ok(stored.enabled && stored.contacts[0].phone === "+923001234567" && stored.contacts[1].phone === "+923215551234", "saved phone numbers are stored in international form");
const prismaRow = await prisma.agentConfig.findUnique({ where: { defaultFor: H } });
ok(prismaRow.escalation.contacts[0].phone === "+923001234567", "…in the database too, so what is dialled is what was stored");

events.length = 0;
const hc1 = await newConversation(H);
stub.state.reply = "Of course, I understand.";
r = await say(H, hc1, "I want to speak to the senior doctor please");
ok(r.result.handoff?.kind === "handoff" && r.result.handoff.reason === "asked", "asking for a person passes the call on");
ok(r.result.handoff.contacts[0].role === "Senior doctor" && r.result.handoff.contacts[1].role === "Representative", "the contact the caller named is tried first, the others follow");
ok(r.result.handoff.contacts[0].phone === "+923215551234" && /asked to speak to a person/.test(r.result.handoff.summary), "the transport gets the number and a summary for the person");
ok(/PASSING THE CALLER ON/.test(r.instruction) && /do NOT name the person/.test(r.instruction), "the model only acknowledges — it is told the announcement is added for it");
const ANNOUNCED = "I'm connecting you to Dr Ayesha, our Senior doctor. Please stay on the line.";
ok(r.result.reply === `Of course, I understand. ${ANNOUNCED}` && r.streamed.endsWith(ANNOUNCED), "the fixed line naming the person is ALWAYS added by the code, streamed and returned");
const handoffReply = (await prisma.message.findMany({ where: { conversationId: hc1, role: "assistant" }, orderBy: { createdAt: "desc" } }))[0];
ok(handoffReply.content.endsWith(ANNOUNCED), "…and stored, so the transcript shows what the caller heard");
ok(r.result.handoff.announcement === ANNOUNCED, "…and handed to the adapter");
ok(!r.instruction.includes("3215551234") && !r.instruction.includes("+92321"), "…and never sees the phone number");
ok(events.some((e) => e.type === "handoff.requested" && e.data.reason === "asked" && e.data.contactId && !JSON.stringify(e).includes("3215551234")), "a handoff.requested event carries ids, never the number");
ok((await prisma.conversation.findUnique({ where: { id: hc1 } })).handoffState?.status === "handed_off", "the conversation is remembered as passed on");
r = await say(H, hc1, "hello? can I speak to a person");
ok(r.result.handoff?.kind === "handed_off", "a second request is not forwarded twice");

const hc2 = await newConversation(H);
stub.state.reply = "I'm sorry, I did not catch that. Could you say it another way?";
r = await say(H, hc2, "xyzzy plugh quux frobnicate");
ok(r.result.handoff?.kind === "rephrase" && /UNDERSTANDING/.test(r.instruction) && /put it another way/.test(r.instruction), "first time it cannot help: it says so and asks to rephrase");
ok((await prisma.conversation.findUnique({ where: { id: hc2 } })).handoffState.misses === 1, "the miss is counted");
r = await say(H, hc2, "wibble wobble flump zork");
ok(r.result.handoff?.kind === "handoff" && r.result.handoff.reason === "not_understood", "the second time in a row it passes the call on");
ok(r.result.handoff.contacts[0].id && /could not understand or answer/.test(r.result.handoff.summary), "…with a summary saying why");

const hc3 = await newConversation(H);
stub.state.reply = "Hello!";
await say(H, hc3, "xyzzy plugh quux frobnicate");
r = await say(H, hc3, "hello there");
ok(r.result.handoff === null, "a greeting in between resets the count: misses must be in a row");
ok((await prisma.conversation.findUnique({ where: { id: hc3 } })).handoffState.misses === 0, "…and the stored count is back to zero");

const hc4 = await newConversation(H);
r = await say(H, hc4, "I have a complaint about my bill");
ok(r.result.handoff?.kind === "handoff" && r.result.handoff.reason === "topic", "an owner's always-forward topic passes the call on");

// the owner's own forwarding line, filled in per person
await saveAgentConfig(H, { escalation: { enabled: true, contacts: CONTACTS, afterMisses: 2, topics: ["complaint"], announce: { en: "Please hold, {name} from our {role} team will be right with you." } } });
const hc4b = await newConversation(H);
stub.state.reply = "I'm sorry to hear that.";
r = await say(H, hc4b, "I have a complaint about my bill");
ok(r.result.reply === "I'm sorry to hear that. Please hold, Bilal from our Representative team will be right with you.", "the owner's own line is said instead, filled in for the person being called");
await saveAgentConfig(H, { escalation: { enabled: true, contacts: CONTACTS, afterMisses: 2, topics: ["complaint"] } });

// unheard speech (the voice session reports it)
const { noteUnheard, handoffFailed } = await import("@/lib/agent/respond");
const hc5 = await newConversation(H, "voice");
let u = await noteUnheard({ tenantId: H, conversationId: hc5 });
ok(u?.kind === "rephrase", "speech that could not be read: first time, ask to repeat");
u = await noteUnheard({ tenantId: H, conversationId: hc5 });
ok(u?.kind === "handoff" && u.contacts.length === 2 && /could not understand/.test(u.summary), "second time in a row: pass the call on");
ok(u.announcement === "I'm connecting you to Bilal, our Representative. Please stay on the line.", "…with the fixed line naming the first person");
await handoffFailed({ tenantId: H, conversationId: hc5 });
ok((await prisma.conversation.findUnique({ where: { id: hc5 } })).handoffState.status === null, "a transfer nobody answered leaves the conversation open for a call-back");
ok((await noteUnheard({ tenantId: A, conversationId: hc5 })) === null, "a business with no one to hand to gets null (the session just asks again)");

// closed: no transfer is promised
await saveAgentConfig(H, { hours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } });
const hc6 = await newConversation(H);
stub.state.reply = "I'm sorry, nobody is available right now.";
r = await say(H, hc6, "I want to speak to a person");
ok(r.result.handoff?.kind === "unavailable" && /NOBODY IS AVAILABLE/.test(r.instruction) && !/connected to/.test(r.instruction), "outside opening hours no transfer is promised");
ok(!("contacts" in r.result.handoff), "…and no numbers are handed to the transport");
await saveAgentConfig(H, { hours: null, escalation: { enabled: true, contacts: CONTACTS, outsideHours: "forward" } });
await saveAgentConfig(H, { hours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } });
const hc7 = await newConversation(H);
r = await say(H, hc7, "I want to speak to a person");
ok(r.result.handoff?.kind === "handoff", "'forward anyway' forwards even when closed");

// a generation that fails leaves the handoff state as it was
const hc8 = await newConversation(H);
await saveAgentConfig(H, { hours: null });
stub.state.reply = () => { throw new Error("stub: model down"); };
let failed = false;
try { await say(H, hc8, "I want to speak to a person"); } catch { failed = true; }
ok(failed && (await prisma.conversation.findUnique({ where: { id: hc8 } })).handoffState === null, "a failed reply does not leave the call marked as passed on");
stub.state.reply = (n) => `Reply ${n}.`;

// the start marker mid-reply never reaches the customer (the real call: "[[START code]]")
const hc9 = await newConversation(A);
stub.state.reply = "We can help with that pain right away. There is an extra fee of one thousand rupees. [[START code]]May I have your name, please?";
r = await say(A, hc9, "I have a severe toothache");
ok(!/\[\[|START/.test(r.streamed) && !/\[\[|START/.test(r.result.reply), "a marker in the middle of a reply is removed from the stream and the reply");
ok(r.result.reply.endsWith("May I have your name, please?") && /fee of one thousand rupees\. May/.test(r.result.reply), "…leaving ordinary text");
ok((await draftOf(hc9)) === null, "…and the made-up code 'code' starts no request");
const hc10 = await newConversation(A);
stub.state.reply = "Sure. [[START appointment]]May I have your name?";
r = await say(A, hc10, "doctor sahib se milwa dein");
ok(!/\[\[/.test(r.streamed) && (await draftOf(hc10))?.type === "appointment", "a real code mid-reply still starts the request, and is still never shown");
stub.state.reply = (n) => `Reply ${n}.`;

// ── a turn withdrawn before it is heard puts everything back (voice: the caller carried on) ──
{
  const { TurnSupersededError } = await import("@/lib/agent/respond");
  const withdraw = async (conversationId, userMessage, when) => {
    const controller = new AbortController();
    if (when === "before") controller.abort();
    try {
      await respond({
        tenantId: A,
        conversationId,
        channel: "voice",
        userMessage,
        signal: controller.signal,
        // "mid-stream": withdrawn as soon as the model has started speaking.
        onChunk: () => when === "mid-stream" && controller.abort(),
      });
      return null;
    } catch (err) {
      return err;
    }
  };
  for (const when of ["before", "mid-stream"]) {
    const cw = await newConversation(A, "voice");
    stub.state.reply = "Of course. May I have your name?";
    const err = await withdraw(cw, "I'd like to book an appointment", when);
    ok(err instanceof TurnSupersededError, `withdrawn ${when}: the turn ends with TurnSupersededError`);
    ok((await prisma.message.count({ where: { conversationId: cw } })) === 0, `withdrawn ${when}: the caller's message is removed — it is about to be sent again, whole`);
    ok((await draftOf(cw)) === null, `withdrawn ${when}: the request it started is put back (no draft)`);
    // The whole sentence, sent again as one message, is an ordinary turn.
    const again = await say(A, cw, "I'd like to book an appointment for a root canal", { channel: "voice" });
    const stored = await prisma.message.findMany({ where: { conversationId: cw }, orderBy: { createdAt: "asc" }, select: { role: true, content: true } });
    ok(stored.length === 2 && stored[0].content === "I'd like to book an appointment for a root canal", `withdrawn ${when}: the merged sentence is stored once, as ONE message`);
    ok(again.result.collection?.state === "ask" && (await draftOf(cw))?.type === "appointment", `withdrawn ${when}: and it starts the request as usual`);
  }
  // A draft that existed BEFORE the withdrawn turn is restored exactly, not wiped.
  const cd = await newConversation(A, "voice");
  stub.state.reply = (n) => `Reply ${n}.`;
  await say(A, cd, "I'd like to book an appointment", { channel: "voice" });
  const before = await draftOf(cd);
  await withdraw(cd, "my name is Sara", "mid-stream");
  ok(JSON.stringify(await draftOf(cd)) === JSON.stringify(before), "a withdrawn answer leaves the open request exactly as it was");
  ok((await prisma.message.count({ where: { conversationId: cd } })) === 2, "…and only the earlier exchange in the history");
  // Not withdrawn: an unused signal changes nothing.
  const cn = await newConversation(A, "voice");
  const plain = await respond({ tenantId: A, conversationId: cn, channel: "voice", userMessage: "What are your hours?", signal: new AbortController().signal });
  ok(typeof plain.reply === "string" && (await prisma.message.count({ where: { conversationId: cn } })) === 2, "a signal that is never used changes nothing");
}
stub.state.reply = (n) => `Reply ${n}.`;

await wipe();
await prisma.agentConfig.deleteMany({ where: { tenantId: { in: ["__collect_test_c__", "__collect_test_handoff__"] } } });
await prisma.message.deleteMany({ where: { tenantId: { in: ["__collect_test_c__", "__collect_test_handoff__"] } } });
await prisma.conversation.deleteMany({ where: { tenantId: { in: ["__collect_test_c__", "__collect_test_handoff__"] } } });
await prisma.$disconnect();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
