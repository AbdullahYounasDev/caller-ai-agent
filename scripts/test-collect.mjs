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
const { createRecord, listRecords, getRecord, updateRecordStatus } = await import("@/lib/standins/records");
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
  const result = await respond({ tenantId, conversationId, channel, userMessage, onChunk: (c) => chunks.push(c) });
  return { result, streamed: chunks.join(""), instruction: stub.state.instructions.at(-1) ?? "" };
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
stub.state.extraction = () => ({ values: {}, date: "2026-12-02", time: "17:00" }); // a Wednesday
let r = await say(A, conv, "What are your opening hours?");
ok(r.result.collection?.state === "idle" && /REQUESTS YOU CAN TAKE/.test(r.instruction), "a question starts nothing; the model is told what it may offer");
ok((await draftOf(conv)) === null, "…and no draft exists");

r = await say(A, conv, "I'd like to book an appointment");
ok(r.result.collection?.state === "ask" && r.result.collection.field === "name", "asking for an appointment: the first question is the name");
ok(/Ask ONLY for: Name/.test(r.instruction) && /you cannot book, confirm or cancel anything yourself/i.test(r.instruction), "the model is told to ask only that, and that it cannot book or confirm");
let draft = await draftOf(conv);
ok(draft?.type === "appointment" && draft.stage === "collecting" && draft.asking === "name", "the draft is saved between messages");

r = await say(A, conv, "my name is Ahmed Khan");
r = await say(A, conv, "0300 1234567");
ok(r.result.collection.field === "service" && /Scaling and polishing, Root canal/.test(r.instruction), "the owner's list of services is offered");
r = await say(A, conv, "root canal");
r = await say(A, conv, "tomorrow at five");
ok(r.result.collection.state === "readback" && /Ahmed Khan/.test(r.instruction) && /03001234567/.test(r.instruction), "everything in: read back with the details");
ok(!/saved with the request number/.test(r.instruction), "…and the model is NOT yet told anything was saved");
ok((await prisma.record.count({ where: { tenantId: A } })) === 0, "nothing is in the records table before the customer says yes");

events.length = 0;
r = await say(A, conv, "yes that's right");
const rows = await prisma.record.findMany({ where: { tenantId: A } });
ok(rows.length === 1 && rows[0].status === "requested" && /^AP-[A-Z0-9]{5}$/.test(rows[0].reference), `a yes saves ONE record, as 'requested' (${rows[0]?.reference})`);
ok(rows[0].data.phone === "+923001234567" && rows[0].data.service === "root_canal" && rows[0].scheduledLocal === "2026-12-02T17:00" && rows[0].timezone === "Asia/Karachi", "stored values are validated: phone in international form, the owner's option id, local time + zone");
ok(rows[0].conversationId === conv && rows[0].channel === "chat" && rows[0].language === "en" && rows[0].configVersion === 2, "it knows its conversation, channel, language and the version of the questions it was taken under");
ok(r.result.collection.state === "submitted" && r.result.collection.reference === rows[0].reference, "respond() reports the reference");
ok(/waits for a team member to confirm/.test(r.instruction) && /Do NOT say it is booked/.test(r.instruction), "the model is told it is recorded, not booked");
ok((await draftOf(conv)) === null, "the draft is cleared");
const customer = await prisma.customer.findFirst({ where: { tenantId: A } });
ok(customer?.phone === "+923001234567" && customer.name === "Ahmed Khan", "the customer was recorded, found by phone number");
ok(events.some((e) => e.type === "record.submitted" && e.tenantId === A && e.data.reference === rows[0].reference && !JSON.stringify(e).includes("Ahmed")), "a record.submitted event was emitted, carrying ids and no personal details");

// ── the same confirmation twice is one record ──────────────────────────────
const again = await createRecord(A, { submissionKey: rows[0].submissionKey, type: "appointment", values: rows[0].data, summary: "x", scheduledAt: null, language: "en" });
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
for (const m of ["نہیں", "میری رپورٹ کے بارے میں", "نہیں", "نہیں"]) r = await say(B, conv3, m, { channel: "voice" });
ok(r.result.collection.state === "readback" && /صفر تین صفر صفر/.test(r.instruction), "on a call the number is read out digit by digit, in Urdu words");
r = await say(B, conv3, "جی ہاں", { channel: "voice" });
const cb = await prisma.record.findFirst({ where: { tenantId: B } });
ok(cb?.type === "callback" && cb.channel === "voice" && cb.language === "ur" && /^CB-/.test(cb.reference), `an Urdu callback was saved from a call (${cb?.reference})`);
ok(/Do not read the request number aloud/.test(r.instruction), "on a call the reference is not read out unless asked");

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

await wipe();
await prisma.agentConfig.deleteMany({ where: { tenantId: "__collect_test_c__" } });
await prisma.message.deleteMany({ where: { tenantId: "__collect_test_c__" } });
await prisma.conversation.deleteMany({ where: { tenantId: "__collect_test_c__" } });
await prisma.$disconnect();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
