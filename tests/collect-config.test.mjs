import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { FIELDS, INDUSTRIES, RECORD_TYPES, LIMITS, getField, getIndustry, pick } from "@/lib/collect/catalog";
import {
  presetConfig,
  emptyCollectConfig,
  normalizeCollectConfig,
  validateCollectConfig,
  fieldDef,
  typeFields,
  choiceOptions,
  recordTypeLabel,
  enabledRecordTypes,
  describeCatalog,
} from "@/lib/collect/config";

const codes = (raw) => validateCollectConfig(raw).problems.map((p) => p.code);

describe("the catalogue is complete in both languages", () => {
  test("every field and record type has a label, a question and a description in English and Urdu", () => {
    for (const f of FIELDS) {
      for (const lang of ["en", "ur"]) {
        assert.ok(f.label[lang]?.length > 1, `${f.id} label ${lang}`);
        assert.ok(f.question[lang]?.length > 1, `${f.id} question ${lang}`);
      }
      assert.ok(["text", "longtext", "phone", "email", "number", "datetime", "choice", "yesno"].includes(f.type), f.id);
    }
    for (const t of RECORD_TYPES) for (const lang of ["en", "ur"]) assert.ok(t.label[lang] && t.description[lang], `${t.id} ${lang}`);
    for (const i of INDUSTRIES) for (const lang of ["en", "ur"]) assert.ok(i.label[lang], `${i.id} ${lang}`);
  });

  test("field ids are unique and every urdu question is written in Urdu script", () => {
    assert.equal(new Set(FIELDS.map((f) => f.id)).size, FIELDS.length);
    for (const f of FIELDS) assert.match(f.question.ur, /[؀-ۿ]/, f.id);
  });

  test("sensitive fields exist, are flagged, and are in NO preset by default", () => {
    const sensitive = FIELDS.filter((f) => f.sensitivity === "sensitive").map((f) => f.id);
    assert.ok(sensitive.includes("age"));
    for (const industry of INDUSTRIES) {
      for (const type of Object.values(industry.recordTypes)) {
        for (const x of type.fields) assert.ok(!sensitive.includes(x.id), `${industry.id} pre-selects sensitive ${x.id}`);
      }
    }
  });

  test("pick falls back across languages", () => {
    assert.equal(pick({ en: "A", ur: "ب" }, "ur"), "ب");
    assert.equal(pick({ en: "A" }, "ur"), "A");
    assert.equal(pick({ ur: "ب" }, "en"), "ب");
    assert.equal(pick(null, "en"), "");
  });
});

describe("every industry preset is itself a valid configuration", () => {
  for (const industry of INDUSTRIES) {
    test(industry.id, () => {
      const config = presetConfig(industry.id);
      config.enabled = true;
      assert.deepEqual(validateCollectConfig(config).problems, [], industry.id);
      // A preset never asks more than a caller will put up with.
      for (const type of RECORD_TYPES) assert.ok(config.recordTypes[type.id].fields.length <= LIMITS.fieldsWarnAt, `${industry.id}/${type.id}`);
    });
  }

  test("the restaurant calls its appointment a table reservation; others keep the default name", () => {
    const restaurant = normalizeCollectConfig({ ...presetConfig("restaurant"), enabled: true });
    assert.equal(recordTypeLabel(restaurant, "appointment", "en"), "Table reservation");
    assert.equal(recordTypeLabel(restaurant, "appointment", "ur"), "میز کی بکنگ");
    assert.equal(recordTypeLabel(normalizeCollectConfig(presetConfig("dental")), "appointment", "en"), "Appointment request");
  });

  test("a call centre takes callbacks and no appointments", () => {
    const c = normalizeCollectConfig({ ...presetConfig("call_center"), enabled: true });
    assert.deepEqual(enabledRecordTypes(c), ["callback"]);
  });

  test("an unknown industry falls back to the general one", () => {
    assert.equal(presetConfig("nope").industry, "general");
    assert.equal(getIndustry("nope"), null);
  });
});

describe("normalizeCollectConfig never throws and always returns a usable shape", () => {
  test("garbage in, a disabled config out", () => {
    for (const raw of [null, undefined, 5, "x", [], {}, { recordTypes: 7 }]) {
      const c = normalizeCollectConfig(raw);
      assert.equal(c.enabled, false);
      assert.deepEqual(enabledRecordTypes(c), []);
      assert.ok(c.recordTypes.appointment && c.recordTypes.callback);
    }
  });

  test("unknown fields and record types are dropped, not trusted", () => {
    const c = normalizeCollectConfig({
      enabled: true,
      industry: "dental",
      recordTypes: { appointment: { enabled: true, fields: [{ id: "name", required: true }, { id: "bogus", required: true }, { id: "phone", required: true }, { id: "datetime", required: true }] }, hacker: { enabled: true, fields: [] } },
    });
    assert.deepEqual(c.recordTypes.appointment.fields.map((f) => f.id), ["name", "phone", "datetime"]);
    assert.equal(c.recordTypes.hacker, undefined);
  });

  test("a stored config is round-trip stable", () => {
    const once = normalizeCollectConfig({ ...presetConfig("salon"), enabled: true, services: [{ label: { en: "Haircut", ur: "ہیئر کٹ" } }] });
    assert.deepEqual(normalizeCollectConfig(once), once);
  });
});

describe("validateCollectConfig tells the owner what is wrong", () => {
  const good = () => ({ ...presetConfig("dental"), enabled: true });

  test("a good configuration has no problems", () => {
    assert.deepEqual(codes(good()), []);
    assert.deepEqual(codes(emptyCollectConfig()), [], "off and empty is fine");
  });

  test("the team must be able to reach the customer: a REQUIRED contact field", () => {
    const c = good();
    c.recordTypes.appointment.fields = c.recordTypes.appointment.fields.map((f) => (f.id === "phone" ? { ...f, required: false } : f));
    assert.deepEqual(codes(c), ["mustReach"]);
    c.recordTypes.appointment.fields.push({ id: "email", required: true });
    assert.deepEqual(codes(c), [], "a required email is enough");
  });

  test("an appointment must have a date and time; a callback must have a phone number", () => {
    const c = good();
    c.recordTypes.appointment.fields = c.recordTypes.appointment.fields.filter((f) => f.id !== "datetime");
    c.recordTypes.callback.fields = c.recordTypes.callback.fields.filter((f) => f.id !== "phone");
    const found = validateCollectConfig(c).problems;
    assert.ok(found.some((p) => p.code === "mustInclude" && p.vars.type === "appointment" && p.vars.field === "datetime"));
    assert.ok(found.some((p) => p.code === "mustInclude" && p.vars.type === "callback" && p.vars.field === "phone"));
  });

  test("a record type that is switched off is not held to those rules", () => {
    const c = good();
    c.recordTypes.callback.enabled = false;
    c.recordTypes.callback.fields = [];
    assert.deepEqual(codes(c), []);
  });

  test("enabled with nothing switched on, and enabled with no fields", () => {
    const none = good();
    none.recordTypes.appointment.enabled = false;
    none.recordTypes.callback.enabled = false;
    assert.deepEqual(codes(none), ["nothingEnabled"]);
    const empty = good();
    empty.recordTypes.callback.fields = [];
    assert.ok(codes(empty).includes("noFields"));
  });

  test("unknown industry, record type or field; duplicates; too many", () => {
    const c = good();
    c.industry = "space_travel";
    c.recordTypes.refund = { enabled: true, fields: [] };
    c.recordTypes.appointment.fields.push({ id: "name", required: true }, { id: "teleport", required: false });
    const found = codes(c);
    for (const code of ["industryUnknown", "recordTypeUnknown", "fieldDuplicate", "fieldUnknown"]) assert.ok(found.includes(code), code);

    const many = good();
    many.recordTypes.callback.fields = [{ id: "phone", required: true }, ...FIELDS.filter((f) => f.id !== "phone").map((f) => ({ id: f.id, required: false }))];
    assert.ok(FIELDS.length > LIMITS.fieldsMax);
    assert.ok(codes(many).includes("tooManyFields"));

    const tooCustom = good();
    tooCustom.customFields = Array.from({ length: LIMITS.customFieldsMax + 1 }, (_, i) => ({ id: `c_f${i}`, type: "text", label: { en: `F${i}` } }));
    assert.ok(codes(tooCustom).includes("customTooMany"));
  });

  test("a body that is not an object is refused", () => {
    assert.deepEqual(codes("nope"), ["invalid"]);
    assert.deepEqual(codes([]), ["invalid"]);
  });
});

describe("services, staff and custom fields", () => {
  test("services get unique ids and keep both languages", () => {
    const { config } = validateCollectConfig({
      ...presetConfig("dental"),
      services: [{ label: { en: "Root canal", ur: "روٹ کینال" } }, { label: { en: "Root canal" } }, { label: { ur: "فلنگ" } }, { label: {} }, "junk"],
    });
    assert.deepEqual(config.services.map((s) => s.id), ["root_canal", "root_canal_2", "s3"]);
    assert.equal(config.services[0].label.ur, "روٹ کینال");
  });

  test("a custom field needs a good id, a known type, a label, and a choice needs two options", () => {
    const base = presetConfig("general");
    assert.ok(codes({ ...base, customFields: [{ id: "parking", type: "text", label: { en: "Parking" } }] }).includes("customIdInvalid"));
    assert.ok(codes({ ...base, customFields: [{ id: "c_name", type: "text", label: { en: "x" } }, { id: "name", type: "text", label: { en: "x" } }] }).includes("customIdInvalid"), "cannot shadow a built-in");
    assert.ok(codes({ ...base, customFields: [{ id: "c_x", type: "phone", label: { en: "X" } }] }).includes("customTypeInvalid"));
    assert.ok(codes({ ...base, customFields: [{ id: "c_x", type: "text", label: {} }] }).includes("customLabelRequired"));
    assert.ok(codes({ ...base, customFields: [{ id: "c_x", type: "choice", label: { en: "X" }, options: [{ label: { en: "A" } }] }] }).includes("customOptionsRequired"));
    const ok = validateCollectConfig({
      ...base,
      customFields: [{ id: "c_parking", type: "choice", label: { en: "Parking", ur: "پارکنگ" }, options: [{ label: { en: "Car" } }, { label: { en: "Bike" } }] }],
    });
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(choiceOptions(ok.config, fieldDef(ok.config, "c_parking")).map((o) => o.id), ["car", "bike"]);
  });

  test("a custom field can be used in a record type and is asked with its own wording", () => {
    const config = normalizeCollectConfig({
      ...presetConfig("general"),
      enabled: true,
      customFields: [{ id: "c_pet", type: "text", label: { en: "Pet name", ur: "پالتو جانور کا نام" }, question: { en: "What is your pet called?" } }],
    });
    config.recordTypes.appointment.fields.push({ id: "c_pet", required: false });
    const fields = typeFields(config, "appointment");
    const pet = fields.find((f) => f.id === "c_pet");
    assert.equal(pet.required, false);
    assert.equal(pet.question.en, "What is your pet called?");
    assert.match(pet.question.ur, /پالتو جانور کا نام/, "no Urdu question given: a plain one built from the label");
  });

  test("choice fields draw their options from the owner's lists", () => {
    const config = normalizeCollectConfig({ ...presetConfig("dental"), services: [{ label: { en: "Braces" } }], staff: [{ label: { en: "Dr Ayesha" } }] });
    assert.deepEqual(choiceOptions(config, getField("service")).map((o) => o.id), ["braces"]);
    assert.deepEqual(choiceOptions(config, getField("staff")).map((o) => o.id), ["dr_ayesha"]);
  });
});

describe("typeFields", () => {
  test("keeps the owner's order, required flags and wording overrides", () => {
    const config = normalizeCollectConfig({
      ...presetConfig("dental"),
      enabled: true,
      recordTypes: {
        appointment: { enabled: true, fields: [{ id: "phone", required: true }, { id: "name", required: false, question: { en: "And you are?" } }, { id: "datetime", required: true }] },
      },
    });
    const fields = typeFields(config, "appointment");
    assert.deepEqual(fields.map((f) => [f.id, f.required]), [["phone", true], ["name", false], ["datetime", true]]);
    assert.equal(fields[1].question.en, "And you are?");
    assert.equal(fields[1].question.ur, getField("name").question.ur, "the catalogue's Urdu where the owner gave none");
  });

  test("a type that does not exist has no fields", () => {
    assert.deepEqual(typeFields(emptyCollectConfig(), "nope"), []);
  });
});

describe("describeCatalog", () => {
  test("is JSON-serialisable and carries every preset as a full config", () => {
    const d = JSON.parse(JSON.stringify(describeCatalog()));
    assert.equal(d.fields.length, FIELDS.length);
    assert.deepEqual(d.industries.map((i) => i.id), INDUSTRIES.map((i) => i.id));
    for (const i of d.industries) assert.deepEqual(validateCollectConfig({ ...i.config, enabled: true }).problems, [], i.id);
  });
});
