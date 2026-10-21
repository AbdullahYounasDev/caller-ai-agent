import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { advanceCollection, newDraft, isLiveDraft, readsAsAnswer, DRAFT_TTL_MS, MAX_RETRIES, summarise, collectedLines } from "@/lib/collect/engine";
import { normalizeCollectConfig, presetConfig, typeFields } from "@/lib/collect/config";

// Wednesday 2026-10-21, 10:00 in Karachi.
const NOW = Date.UTC(2026, 9, 21, 5, 0);
const HOURS = { mon: [["10:00", "20:00"]], tue: [["10:00", "20:00"]], wed: [["10:00", "20:00"]], thu: [["10:00", "20:00"]], fri: [["10:00", "20:00"]], sat: [["10:00", "20:00"]], sun: [] };

// The dental preset ends with an OPTIONAL "anything else" question; most tests use the form without it.
const dentalFull = () =>
  normalizeCollectConfig({
    ...presetConfig("dental"),
    enabled: true,
    services: [{ label: { en: "Scaling and polishing", ur: "صفائی اور پالش" } }, { label: { en: "Root canal", ur: "روٹ کینال" } }],
  });
const dental = () => {
  const c = dentalFull();
  c.recordTypes.appointment.fields = c.recordTypes.appointment.fields.filter((f) => f.id !== "notes");
  return c;
};
const agent = (over = {}) => ({ replyLanguage: "en", timezone: "Asia/Karachi", hours: HOURS, ...over });

/** A whole conversation against the engine, with the model and the database faked. */
function conversation({ collect = dental(), agentConfig = agent(), extract = null } = {}) {
  const saved = [];
  const updates = [];
  const withdrawn = [];
  let draft = null;
  let clock = NOW;
  let ids = 0;
  const deps = {
    newId: () => `draft-${++ids}`,
    extract,
    submit: async (record) => {
      const existing = saved.find((s) => s.submissionKey === record.submissionKey);
      if (existing) return existing;
      const row = { ...record, id: `rec-${saved.length + 1}`, reference: `AP-${saved.length + 1}ABCD` };
      saved.push(row);
      return row;
    },
    update: async (id, record) => {
      updates.push({ id, ...record });
      Object.assign(saved.find((s) => s.id === id), record);
      return { ok: true };
    },
    withdraw: async (id) => {
      withdrawn.push(id);
      return { ok: true };
    },
  };
  const history = [];
  return {
    saved,
    updates,
    withdrawn,
    get draft() {
      return draft;
    },
    set draft(value) {
      draft = value;
    },
    tick: (ms) => (clock += ms),
    async say(message) {
      const result = await advanceCollection({ collect, agent: agentConfig, draft, message, history: [...history], nowMs: clock, deps });
      draft = result.draft;
      history.push({ role: "user", content: message });
      return result;
    },
  };
}

describe("a customer books an appointment, step by step", () => {
  test("rules alone take a whole appointment, one question at a time, and it is saved the moment the last detail is in", async () => {
    const c = conversation();

    let r = await c.say("What are your opening hours?");
    assert.equal(r.plan.state, "idle", "a question starts nothing");
    assert.deepEqual(r.plan.offers.map((o) => o.type).sort(), ["appointment", "callback"]);
    assert.equal(r.plan.offers.find((o) => o.type === "appointment").firstQuestion, "May I have your name, please?");
    assert.equal(c.draft, null);

    r = await c.say("I'd like to book an appointment");
    assert.equal(r.plan.state, "ask");
    assert.equal(r.plan.firstAsk, true);
    assert.equal(r.plan.ask.id, "name");
    assert.equal(r.draft.stage, "collecting");

    r = await c.say("my name is Ahmed Khan");
    assert.equal(c.draft.values.name, "Ahmed Khan");
    assert.equal(r.plan.ask.id, "phone");
    assert.equal(r.plan.firstAsk, false);
    assert.deepEqual(r.plan.collected.map((l) => [l.id, l.display]), [["name", "Ahmed Khan"]]);

    r = await c.say("0300 1234567");
    assert.equal(c.draft.values.phone, "+923001234567");
    assert.equal(r.plan.ask.id, "service");
    assert.deepEqual(r.plan.ask.options, ["Scaling and polishing", "Root canal"]);

    r = await c.say("root canal");
    assert.equal(c.draft.values.service, "root_canal");
    assert.equal(r.plan.ask.id, "datetime", "the model is needed for a day and time");
    assert.equal(c.saved.length, 0, "a required detail is still missing: nothing saved yet");
  });

  test("the last required detail saves the request at once, with a reference, then it is read back", async () => {
    const asked = [];
    const c = conversation({
      extract: async (request) => {
        asked.push(request.fields.map((f) => f.id));
        return { values: {}, date: "2026-10-22", time: "17:00" };
      },
    });
    for (const m of ["book an appointment", "Ahmed Khan", "03001234567", "scaling"]) await c.say(m);
    assert.equal(c.saved.length, 0);
    const r = await c.say("tomorrow at 5");
    assert.equal(c.draft.values.datetime, "2026-10-22T17:00");
    assert.equal(r.plan.state, "saved");
    assert.equal(r.plan.justSaved, true);
    assert.equal(r.plan.reference, "AP-1ABCD");
    assert.equal(c.draft.stage, "saved", "the draft stays so a correction can find the row");
    assert.equal(c.draft.recordId, "rec-1");
    assert.deepEqual(r.plan.lines.map((l) => l.id), ["name", "phone", "service", "datetime"]);
    assert.equal(r.plan.lines.find((l) => l.id === "service").display, "Scaling and polishing");
    assert.equal(c.saved.length, 1, "saved without waiting for a yes");
    const row = c.saved[0];
    assert.equal(row.type, "appointment");
    assert.deepEqual(row.values, { name: "Ahmed Khan", phone: "+923001234567", service: "scaling_and_polishing", datetime: "2026-10-22T17:00" });
    assert.equal(row.scheduledAt, "2026-10-22T17:00");
    assert.equal(row.language, "en");
    assert.match(row.summary, /Ahmed Khan · Scaling and polishing · Thursday, 22 October 2026/);
    assert.ok(asked.length >= 1);
  });

  test("a customer who just says thanks leaves the saved request alone and ends it", async () => {
    const c = conversation({ extract: async () => ({ values: {}, date: "2026-10-22", time: "17:00" }) });
    for (const m of ["book an appointment", "Ahmed Khan", "03001234567", "scaling", "tomorrow at 5"]) await c.say(m);
    const r = await c.say("okay thank you");
    assert.equal(r.plan.state, "closed");
    assert.equal(r.plan.reference, "AP-1ABCD");
    assert.equal(c.draft, null);
    assert.equal(c.saved.length, 1);
    assert.deepEqual(c.updates, []);
  });

  test("everything in one sentence is saved in that same turn", async () => {
    const c = conversation({
      extract: async (req) => {
        assert.ok(req.fields.length >= 3);
        return { values: { name: "Sara", service: "root_canal" }, date: "2026-10-23", time: "11:00" };
      },
    });
    const r = await c.say("Hi I am Sara, call 0321 5551234, root canal on Friday at 11 please, book an appointment");
    assert.equal(c.draft.values.phone, "+923215551234", "the number is found by rule");
    assert.equal(c.draft.values.service, "root_canal");
    assert.equal(r.plan.state, "saved", "all four fields arrived at once");
    assert.equal(c.saved.length, 1);
    assert.equal((await c.say("ji haan")).plan.state, "closed");
    assert.equal(c.saved.length, 1, "the yes saves nothing more");
  });
});

describe("wrong, missing and unusable answers", () => {
  test("a phone number that is not one is asked for again, with the reason", async () => {
    const c = conversation();
    await c.say("book an appointment");
    await c.say("Ahmed");
    let r = await c.say("12 34");
    assert.equal(r.plan.state, "ask");
    assert.equal(r.plan.ask.id, "phone");
    assert.deepEqual(r.plan.problem, { field: { id: "phone", label: "Phone number" }, reason: "invalid_phone", vars: undefined });
    assert.equal(c.draft.retries.phone, 1);
    r = await c.say("0300 1234567");
    assert.equal(r.plan.problem, null);
    assert.equal(r.plan.ask.id, "service");
    assert.equal(c.draft.retries.phone, undefined, "a good answer clears the count");
  });

  test("two unusable answers to a required question stop the request without saving anything", async () => {
    const c = conversation();
    await c.say("book an appointment");
    await c.say("Ahmed");
    await c.say("123");
    const r = await c.say("456");
    assert.equal(r.plan.state, "stuck");
    assert.match(JSON.stringify(r.plan.field), /phone/);
    assert.equal(r.plan.field.id, "phone");
    assert.equal(c.draft, null);
    assert.equal(c.saved.length, 0);
    assert.equal(MAX_RETRIES, 2);
  });

  test("a day the business is closed is refused with the reason", async () => {
    const c = conversation({ extract: async () => ({ values: {}, date: "2026-10-25", time: "11:00" }) });
    for (const m of ["book an appointment", "Ahmed", "03001234567", "scaling"]) await c.say(m);
    const r = await c.say("Sunday at eleven");
    assert.equal(r.plan.state, "ask");
    assert.equal(r.plan.ask.id, "datetime");
    assert.deepEqual(r.plan.problem.reason, "closed");
    assert.deepEqual(r.plan.problem.vars, { day: "sun" });
    assert.deepEqual(c.draft.partial, {}, "a rejected time is not kept");
  });

  test("only a day is given: the time is asked for next, and the day is remembered", async () => {
    const c = conversation({ extract: async () => ({ values: {}, date: "2026-10-22", time: null }) });
    for (const m of ["book an appointment", "Ahmed", "03001234567", "scaling"]) await c.say(m);
    let r = await c.say("tomorrow");
    assert.equal(r.plan.ask.id, "datetime");
    assert.match(r.plan.ask.have.date, /Thursday, 22 October 2026/);
    assert.deepEqual(c.draft.partial, { date: "2026-10-22" });

    c.deps = null;
    const c2 = c;
    c2.tick(1000);
    // the time arrives in a later message
    const again = conversation({ extract: async () => ({ values: {}, date: null, time: "15:30" }) });
    again.draft = c.draft;
    r = await again.say("3:30 pm");
    assert.equal(again.draft.values.datetime, "2026-10-22T15:30");
    assert.equal(r.plan.state, "saved");
  });

  test("when the model is down the rules still take everything they can, and the turn says so", async () => {
    const c = conversation({ extract: async () => { throw new Error("rate limited"); } });
    for (const m of ["book an appointment", "Ahmed", "03001234567", "scaling"]) await c.say(m);
    const r = await c.say("kal shaam paanch baje");
    assert.equal(r.plan.state, "ask");
    assert.equal(r.plan.ask.id, "datetime");
    assert.equal(r.plan.extractionFailed, true);
    assert.equal(r.plan.problem, null, "not the customer's fault");
  });

  test("a side question while a detail is open does not become the detail", async () => {
    const c = conversation({ extract: async () => ({ values: {}, date: null, time: null }) });
    await c.say("book an appointment");
    await c.say("Ahmed");
    const r = await c.say("what is your address?");
    assert.equal(c.draft.values.phone, undefined);
    assert.equal(r.plan.ask.id, "phone", "and the question is asked again");
    const q = await c.say("آپ کا پتہ کیا ہے؟");
    assert.equal(q.plan.ask.id, "phone");
  });
});

describe("optional questions", () => {
  const withNotes = () => conversation({ collect: dentalFull(), extract: async () => ({ values: {}, date: "2026-10-22", time: "17:00" }) });
  const toNotes = async (c) => {
    for (const m of ["book an appointment", "Ahmed", "03001234567", "scaling"]) await c.say(m);
    return c.say("tomorrow at 5");
  };

  test("the request is saved BEFORE the optional question is asked, so a hang-up loses nothing", async () => {
    const c = withNotes();
    const r = await toNotes(c);
    assert.equal(r.plan.state, "ask");
    assert.equal(r.plan.ask.id, "notes");
    assert.equal(c.saved.length, 1);
    assert.equal(r.plan.saved.justSaved, true);
    assert.equal(r.plan.saved.reference, "AP-1ABCD");
  });

  test("an optional question can be declined in English, Urdu or Roman Urdu — and is not asked again", async () => {
    for (const decline of ["no", "نہیں", "koi nahi", "skip it", "rehne do"]) {
      const c = withNotes();
      await toNotes(c);
      assert.equal(c.draft.asking, "notes", decline);
      const r = await c.say(decline);
      assert.equal(r.plan.state, "saved", decline);
      assert.equal(r.plan.justSaved, false, "it was announced when it was saved");
      assert.ok(c.draft.skipped.includes("notes"), decline);
      assert.equal(c.saved.length, 1, decline);
    }
  });

  test("an optional answer updates the saved row instead of creating another", async () => {
    const c = withNotes();
    await toNotes(c);
    const r = await c.say("I am scared of the dentist, please be gentle");
    assert.equal(c.draft.values.notes, "I am scared of the dentist, please be gentle");
    assert.equal(r.plan.state, "saved");
    assert.equal(r.plan.lines.at(-1).id, "notes");
    assert.equal(c.saved.length, 1);
    assert.equal(c.updates.length, 1);
    assert.equal(c.updates[0].values.notes, "I am scared of the dentist, please be gentle");
  });

  test("an optional question that is simply ignored is not repeated", async () => {
    const c = withNotes();
    await toNotes(c);
    const r = await c.say("what time do you close?");
    assert.equal(r.plan.state, "saved", "it moved on instead of asking for notes a second time");
    assert.equal(c.saved.length, 1);
  });

  test("'forget it' while an optional question is open withdraws the saved request", async () => {
    const c = withNotes();
    await toNotes(c);
    const r = await c.say("cancel it");
    assert.equal(r.plan.state, "withdrawn");
    assert.deepEqual(c.withdrawn, ["rec-1"]);
    assert.equal(c.draft, null);
  });
});

describe("after it is saved: correcting, closing and withdrawing", () => {
  async function saved(extra = {}) {
    const c = conversation({ extract: async () => ({ values: {}, date: "2026-10-22", time: "17:00" }), ...extra });
    for (const m of ["book an appointment", "Ahmed", "03001234567", "scaling", "tomorrow at 5"]) await c.say(m);
    assert.equal(c.draft.stage, "saved");
    return c;
  }

  test("a correction updates the saved row — it never makes a second one", async () => {
    const c = await saved();
    const r = await c.say("no, the phone number is 0333 1112233");
    assert.equal(c.draft.values.phone, "+923331112233");
    assert.equal(r.plan.state, "saved");
    assert.deepEqual(r.plan.corrected.map((l) => l.id), ["phone"]);
    assert.equal(c.saved.length, 1);
    assert.equal(c.updates.length, 1);
    assert.equal(c.updates[0].id, "rec-1");
    assert.equal(c.updates[0].values.phone, "+923331112233");
    assert.equal(c.saved[0].values.phone, "+923331112233");
  });

  test("'no' asks which detail is wrong; the next message corrects it", async () => {
    const c = await saved();
    let r = await c.say("no");
    assert.equal(r.plan.state, "change");
    assert.deepEqual(r.plan.fields.map((f) => f.id), ["name", "phone", "service", "datetime"]);
    r = await c.say("the time is wrong");
    assert.equal(r.plan.state, "change", "still asking which / what the new value is");
    r = await c.say("my phone number is 0333 1112233");
    assert.equal(c.draft.values.phone, "+923331112233");
    assert.equal(r.plan.state, "saved");
    assert.equal(c.updates.length, 1);
  });

  test("an unusable correction changes nothing and says why", async () => {
    const c = await saved();
    c.draft = structuredClone(c.draft);
    const bad = conversation({ extract: async () => ({ values: { phone: "12 34" }, date: null, time: null }) });
    bad.draft = c.draft;
    bad.saved.push(...c.saved);
    const r = await bad.say("no, the phone number is wrong, it is twelve thirty four");
    assert.equal(bad.draft.values.phone, "+923001234567");
    assert.equal(r.plan.problem.reason, "invalid_phone");
    assert.deepEqual(bad.updates, []);
  });

  test("a question instead of an answer is answered, then the details are checked again", async () => {
    const c = await saved();
    const r = await c.say("do you take cards?");
    assert.equal(r.plan.state, "saved");
    assert.equal(r.plan.reconfirm, true);
    assert.equal(c.saved.length, 1);
  });

  test("'forget it' after the read-back withdraws the request", async () => {
    const c = await saved();
    const r = await c.say("forget it");
    assert.equal(r.plan.state, "withdrawn");
    assert.deepEqual(c.withdrawn, ["rec-1"]);
    assert.equal(c.draft, null);
  });

  test("a weak 'maybe later' never withdraws a saved request", async () => {
    const c = await saved();
    const r = await c.say("ok, talk later");
    assert.notEqual(r.plan.state, "withdrawn");
    assert.deepEqual(c.withdrawn, []);
  });

  test("a second, different request in the same conversation starts afresh", async () => {
    const c = await saved();
    const r = await c.say("please call me back too");
    assert.equal(r.plan.type, "callback");
    assert.equal(r.plan.state, "ask");
    assert.equal(c.saved.length, 1, "the first stays; the second is not saved until it is complete");
  });

  test("a row a person already confirmed cannot be changed by the agent", async () => {
    const c = await saved();
    const locked = await advanceCollection({
      collect: dental(),
      agent: agent(),
      draft: c.draft,
      message: "no, the phone number is 0333 1112233",
      nowMs: NOW + 1000,
      deps: { newId: () => "x", update: async () => ({ ok: false, reason: "locked" }), withdraw: async () => ({ ok: false }) },
    });
    assert.equal(locked.plan.state, "update_failed");
  });

  test("a failed save is retried on the customer's next message, under the same key, exactly once", async () => {
    const c = conversation({ extract: async () => ({ values: {}, date: "2026-10-22", time: "17:00" }) });
    for (const m of ["book an appointment", "Ahmed", "03001234567", "scaling"]) await c.say(m);
    let failures = 1;
    const keys = [];
    const deps = {
      newId: () => "x",
      extract: async () => ({ values: {}, date: "2026-10-22", time: "17:00" }),
      submit: async (rec) => {
        keys.push(rec.submissionKey);
        if (failures-- > 0) throw new Error("db down");
        return { id: "r1", reference: "AP-OK" };
      },
    };
    const failed = await advanceCollection({ collect: dental(), agent: agent(), draft: c.draft, message: "tomorrow at 5", nowMs: NOW, deps });
    assert.equal(failed.plan.state, "submit_failed");
    assert.equal(failed.draft.recordId, undefined);
    const retry = await advanceCollection({ collect: dental(), agent: agent(), draft: failed.draft, message: "hello?", nowMs: NOW + 1000, deps });
    assert.equal(retry.plan.state, "saved");
    assert.equal(retry.plan.reference, "AP-OK");
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 1, "the same submission key both times");
  });
});

describe("backing out, expiry and what a business has switched off", () => {
  test("'cancel it' in the middle of the form clears the draft", async () => {
    const c = conversation();
    await c.say("book an appointment");
    await c.say("Ahmed");
    const r = await c.say("actually cancel it");
    assert.equal(r.plan.state, "cancelled");
    assert.equal(c.draft, null);
  });

  test("a weak 'never mind' cancels at a required question but only skips an optional one", async () => {
    const required = conversation();
    await required.say("book an appointment");
    assert.equal((await required.say("never mind")).plan.state, "cancelled");
  });

  test("a draft nobody touched for half an hour is forgotten, and the next message starts afresh", async () => {
    const c = conversation();
    await c.say("book an appointment");
    await c.say("Ahmed");
    c.tick(DRAFT_TTL_MS + 1000);
    assert.equal(isLiveDraft(c.draft, { nowMs: NOW + DRAFT_TTL_MS + 1000, collect: dental() }), false);
    const r = await c.say("0300 1234567");
    assert.equal(r.plan.state, "idle", "a number alone starts nothing");
    assert.equal(c.draft, null);
  });

  test("a business that switched the feature off is never asked anything", async () => {
    const c = conversation({ collect: normalizeCollectConfig({ ...presetConfig("dental"), enabled: false }) });
    const r = await c.say("I want to book an appointment");
    assert.equal(r.plan, null);
    assert.equal(c.draft, null);
  });

  test("a record type that is switched off is not offered or started", async () => {
    const c = conversation({ collect: normalizeCollectConfig({ ...presetConfig("call_center"), enabled: true }) });
    assert.equal((await c.say("book an appointment")).plan.state, "idle");
    const r = await c.say("please call me back");
    assert.equal(r.plan.type, "callback");
    assert.equal(r.plan.ask.id, "name");
  });

  test("a stored draft for a type the owner has since switched off is dropped", async () => {
    const stale = newDraft({ type: "appointment", nowMs: NOW, id: "old" });
    const collect = normalizeCollectConfig({ ...presetConfig("call_center"), enabled: true });
    const r = await advanceCollection({ collect, agent: agent(), draft: stale, message: "hello", nowMs: NOW, deps: { newId: () => "n" } });
    assert.equal(r.plan.state, "idle");
    assert.equal(r.draft, null);
    assert.equal(r.changed, true, "the stale draft must be cleared from storage");
  });
});

describe("Urdu", () => {
  test("a whole callback in Urdu, with Urdu digits, saved in the Urdu the business replies in", async () => {
    const c = conversation({ collect: normalizeCollectConfig({ ...presetConfig("call_center"), enabled: true }), agentConfig: agent({ replyLanguage: "ur" }) });
    let r = await c.say("مجھے واپس کال کریں");
    assert.equal(r.plan.state, "ask");
    assert.equal(r.plan.language, "ur");
    assert.equal(r.plan.ask.question, "براہِ کرم اپنا نام بتائیں۔", "the Urdu wording, not the English");
    r = await c.say("میرا نام احمد ہے");
    assert.equal(c.draft.values.name, "احمد");
    r = await c.say("۰۳۰۰ ۱۲۳۴۵۶۷");
    assert.equal(c.draft.values.phone, "+923001234567");
    assert.equal(r.plan.ask.id, "company", "questions come in the owner's order, optional ones included");
    r = await c.say("نہیں");
    assert.equal(r.plan.ask.id, "reason");
    r = await c.say("میری رپورٹ کے بارے میں");
    assert.equal(r.plan.ask.id, "callback_window");
    r = await c.say("نہیں");
    assert.equal(r.plan.ask.id, "reference");
    r = await c.say("نہیں");
    assert.equal(r.plan.state, "saved");
    const done = await c.say("جی ہاں");
    assert.equal(done.plan.state, "closed");
    assert.equal(c.saved[0].language, "ur");
    assert.equal(c.saved[0].values.reason, "میری رپورٹ کے بارے میں");
  });

  test("Roman Urdu names, numbers and confirmation work the same", async () => {
    const c = conversation();
    await c.say("mujhe doctor se milna hai");
    assert.equal(c.draft?.type, "appointment");
    await c.say("mera naam Bilal hai");
    assert.equal(c.draft.values.name, "Bilal");
    await c.say("zero three two one five five five one two three four");
    assert.equal(c.draft.values.phone, "+923215551234");
  });
});

describe("summaries and lines", () => {
  test("a callback is summarised by name, reason and window", () => {
    const collect = normalizeCollectConfig({ ...presetConfig("call_center"), enabled: true });
    const fields = typeFields(collect, "callback");
    const draft = { ...newDraft({ type: "callback", nowMs: NOW, id: "d" }), values: { name: "Bilal", phone: "+923001234567", reason: "Invoice", callback_window: "after 5" } };
    const ctx = { config: collect, timezone: "UTC", hours: null, nowMs: NOW, language: "en" };
    assert.equal(summarise(draft, fields, ctx), "Bilal · Invoice · after 5");
    assert.deepEqual(collectedLines(draft, fields, ctx).map((l) => l.id), ["name", "phone", "reason", "callback_window"]);
  });
});

describe("readsAsAnswer — a message that is only the answer is not worth a document search", () => {
  const check = (draft, message, collect = dental()) => readsAsAnswer({ collect, agent: agent(), draft, message, nowMs: NOW });
  const askingNow = async (...messages) => {
    const c = conversation();
    for (const m of messages) await c.say(m);
    return c;
  };

  test("no open request: every message is searched as usual", async () => {
    assert.equal(check(null, "Ahmed Khan"), false);
    assert.equal(check(null, "0300 1234567"), false);
  });

  test("the answer to the question just asked skips the search", async () => {
    let c = await askingNow("book an appointment");
    assert.equal(c.draft.asking, "name");
    assert.equal(check(c.draft, "my name is Ahmed Khan"), true);
    c = await askingNow("book an appointment", "Ahmed Khan");
    assert.equal(c.draft.asking, "phone");
    assert.equal(check(c.draft, "0300 1234567"), true);
    assert.equal(check(c.draft, "zero three zero zero one two three four five six seven"), true);
    c = await askingNow("book an appointment", "Ahmed Khan", "03001234567");
    assert.equal(c.draft.asking, "service");
    assert.equal(check(c.draft, "root canal"), true);
  });

  test("a day and time (short, plain) skips the search", async () => {
    const c = await askingNow("book an appointment", "Ahmed Khan", "03001234567", "scaling");
    assert.equal(c.draft.asking, "datetime");
    assert.equal(check(c.draft, "tomorrow at five"), true);
    assert.equal(check(c.draft, "Monday ten am"), true);
    assert.equal(check(c.draft, "kal shaam paanch baje"), true);
  });

  test("a question while a detail is open is still searched", async () => {
    const c = await askingNow("book an appointment", "Ahmed Khan");
    for (const q of ["what is your address?", "do you take cards", "How much does it cost", "آپ کا پتہ کیا ہے؟", "kitna kharcha hoga"]) {
      assert.equal(check(c.draft, q), false, q);
    }
  });

  test("a long message, or one the rules cannot place, is still searched", async () => {
    const c = await askingNow("book an appointment", "Ahmed Khan");
    assert.equal(check(c.draft, "my number is 03001234567 and I also wanted to ask about the insurance plans you work with"), false);
    assert.equal(check(c.draft, "what about the weather"), false);
  });

  test("after it is saved, 'yes', 'thanks' and a correction skip the search; a new question does not", async () => {
    const c = conversation({ extract: async () => ({ values: {}, date: "2026-10-22", time: "17:00" }) });
    for (const m of ["book an appointment", "Ahmed", "03001234567", "scaling", "tomorrow at 5"]) await c.say(m);
    assert.equal(c.draft.stage, "saved");
    for (const m of ["yes", "ji haan", "thanks", "that's all", "no, my phone is 0333 1112233", "cancel it"]) assert.equal(check(c.draft, m), true, m);
    for (const m of ["what time do you close?", "do you have parking"]) assert.equal(check(c.draft, m), false, m);
  });

  test("a declined optional question skips the search", async () => {
    const c = conversation({ collect: dentalFull(), extract: async () => ({ values: {}, date: "2026-10-22", time: "17:00" }) });
    for (const m of ["book an appointment", "Ahmed", "03001234567", "scaling", "tomorrow at 5"]) await c.say(m);
    assert.equal(c.draft.asking, "notes");
    assert.equal(readsAsAnswer({ collect: dentalFull(), agent: agent(), draft: c.draft, message: "no", nowMs: NOW }), true);
  });

  test("an expired draft is no reason to skip", async () => {
    const c = await askingNow("book an appointment", "Ahmed Khan");
    assert.equal(readsAsAnswer({ collect: dental(), agent: agent(), draft: c.draft, message: "0300 1234567", nowMs: NOW + DRAFT_TTL_MS + 1 }), false);
  });
});
