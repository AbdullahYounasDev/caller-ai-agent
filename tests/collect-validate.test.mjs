import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDigits,
  digitsAsWords,
  findPhoneInText,
  normalizePhone,
  normalizeEmail,
  parseNumber,
  parseYesNo,
  matchOption,
  zonedNow,
  dayOf,
  checkHours,
  formatDateTime,
  validateValue,
  displayValue,
} from "@/lib/collect/validate";
import { getField } from "@/lib/collect/catalog";
import { normalizeCollectConfig, presetConfig } from "@/lib/collect/config";

// 2026-10-21 is a Wednesday. 10:00 in Karachi (UTC+5) is 05:00 UTC.
const NOW = Date.UTC(2026, 9, 21, 5, 0);
const HOURS = { mon: [["10:00", "20:00"]], tue: [["10:00", "20:00"]], wed: [["10:00", "20:00"]], thu: [["10:00", "20:00"]], fri: [["10:00", "12:30"], ["14:30", "20:00"]], sat: [["10:00", "20:00"]], sun: [] };
const config = () => ({ ...normalizeCollectConfig(presetConfig("dental")), services: [{ id: "scaling", label: { en: "Scaling and polishing", ur: "صفائی اور پالش" } }, { id: "root_canal", label: { en: "Root canal", ur: "روٹ کینال" } }] });
const ctx = (over = {}) => ({ config: config(), timezone: "Asia/Karachi", hours: HOURS, nowMs: NOW, language: "en", ...over });

describe("digits", () => {
  test("Urdu and Arabic-Indic digits become ASCII", () => {
    assert.equal(normalizeDigits("۰۳۰۰ ١٢٣٤٥٦٧"), "0300 1234567");
    assert.equal(normalizeDigits("plan 5"), "plan 5");
  });

  test("digits read out as words, in both languages", () => {
    assert.equal(digitsAsWords("0300", "en"), "zero three zero zero");
    assert.equal(digitsAsWords("0300", "ur"), "صفر تین صفر صفر");
    assert.equal(digitsAsWords("+92 3", "en"), "nine two three");
  });
});

describe("findPhoneInText", () => {
  test("finds a number written in digits in any script", () => {
    assert.equal(findPhoneInText("my number is 0300 1234567 thanks"), "03001234567");
    assert.equal(findPhoneInText("میرا نمبر ۰۳۰۰۱۲۳۴۵۶۷ ہے"), "03001234567");
    assert.equal(findPhoneInText("call +92 300 1234567"), "+923001234567");
  });

  test("finds a number spoken one digit word at a time, in English, Urdu and Roman Urdu", () => {
    assert.equal(findPhoneInText("zero three zero zero one two three four five six seven"), "03001234567");
    assert.equal(findPhoneInText("صفر تین صفر صفر ایک دو تین چار پانچ چھ سات"), "03001234567");
    assert.equal(findPhoneInText("sifar teen sifar sifar aik do teen char paanch chhe saat"), "03001234567");
  });

  test("ordinary words and short numbers are not a phone number", () => {
    assert.equal(findPhoneInText("I need two appointments for 5 people"), null);
    assert.equal(findPhoneInText("mujhe do din baad aana hai"), null);
    assert.equal(findPhoneInText(""), null);
  });
});

describe("normalizePhone — Pakistan first", () => {
  test("every common way of writing one mobile number is the same number", () => {
    for (const raw of ["0300-1234567", "0300 1234567", "03001234567", "3001234567", "+92 300 1234567", "923001234567", "0092 300 1234567", "9203001234567", "۰۳۰۰۱۲۳۴۵۶۷"]) {
      const r = normalizePhone(raw);
      assert.deepEqual([r.ok, r.value, r.local], [true, "+923001234567", "03001234567"], raw);
    }
  });

  test("a landline with its area code", () => {
    assert.equal(normalizePhone("021-35551234").value, "+922135551234");
  });

  test("another country is accepted when it says so", () => {
    assert.equal(normalizePhone("+44 20 7946 0958").value, "+442079460958");
    assert.equal(normalizePhone("0044 20 7946 0958").value, "+442079460958");
  });

  test("too short, too long or not a number is refused", () => {
    for (const raw of ["", "abc", "12345", "0300", "03001234567890123", "+12"]) assert.equal(normalizePhone(raw).ok, false, raw);
  });
});

describe("email, number, yes/no", () => {
  test("an address, including the way it is spoken", () => {
    assert.equal(normalizeEmail("Ahmed@Gmail.com").value, "ahmed@gmail.com");
    assert.equal(normalizeEmail("ahmed at gmail dot com").value, "ahmed@gmail.com");
    assert.equal(normalizeEmail("ahmed ایٹ gmail ڈاٹ com").value, "ahmed@gmail.com");
    for (const bad of ["ahmed", "ahmed@", "a@b", "ahmed gmail.com"]) assert.equal(normalizeEmail(bad).ok, false, bad);
  });

  test("numbers in digits, Urdu digits and words", () => {
    assert.equal(parseNumber("I am 34 years old"), 34);
    assert.equal(parseNumber("میری عمر ۳۴ سال ہے"), 34);
    assert.equal(parseNumber("paanch log"), 5);
    assert.equal(parseNumber("no idea"), null);
  });

  test("yes and no in English, Urdu and Roman Urdu", () => {
    for (const yes of ["yes", "Yes please", "ji haan", "haan", "bilkul", "ہاں", "جی ہاں", "ٹھیک ہے", "theek hai"]) assert.equal(parseYesNo(yes), "yes", yes);
    for (const no of ["no", "nope", "nahi", "nahin", "نہیں", "جی نہیں", "غلط", "ji nahi", "theek nahi hai", "sahi nahi"]) assert.equal(parseYesNo(no), "no", no);
    for (const other of ["maybe later", "what are your hours", ""]) assert.equal(parseYesNo(other), null, other);
  });
});

describe("matchOption", () => {
  const options = config().services;
  test("exact id or label in either language", () => {
    assert.equal(matchOption("root_canal", options).id, "root_canal");
    assert.equal(matchOption("Root canal", options).id, "root_canal");
    assert.equal(matchOption("روٹ کینال", options).id, "root_canal");
  });

  test("a label inside a longer answer", () => {
    assert.equal(matchOption("I need scaling and polishing please", options).id, "scaling");
  });

  test("nothing, or two candidates, matches nothing", () => {
    assert.equal(matchOption("braces", options), null);
    assert.equal(matchOption("", options), null);
    const twin = [{ id: "a", label: { en: "Hair colour" } }, { id: "b", label: { en: "Hair colour long" } }];
    assert.equal(matchOption("hair colour long hair", twin)?.id, "b", "the longest label the answer contains wins");
    const tie = [{ id: "a", label: { en: "Facial" } }, { id: "b", label: { en: "Waxing" } }];
    assert.equal(matchOption("facial and waxing", tie), null, "two equally long labels is ambiguous");
    assert.equal(matchOption("canal", options)?.id, "root_canal", "an unambiguous part of one label");
  });
});

describe("time", () => {
  test("zonedNow reads the wall clock in the business's zone", () => {
    assert.deepEqual(zonedNow(NOW, "Asia/Karachi"), { date: "2026-10-21", time: "10:00", day: "wed" });
    assert.deepEqual(zonedNow(NOW, "UTC"), { date: "2026-10-21", time: "05:00", day: "wed" });
    assert.equal(zonedNow(NOW, "Not/AZone").time, "05:00", "an unknown zone degrades to UTC");
  });

  test("dayOf", () => {
    assert.equal(dayOf("2026-10-21"), "wed");
    assert.equal(dayOf("2026-10-25"), "sun");
  });

  test("opening hours: inside, at the edges, closed day, lunch break, and no hours on record", () => {
    assert.equal(checkHours(HOURS, "2026-10-21", "10:00").ok, true);
    assert.equal(checkHours(HOURS, "2026-10-21", "19:59").ok, true);
    assert.equal(checkHours(HOURS, "2026-10-21", "20:00").ok, false, "closing time is closed");
    assert.equal(checkHours(HOURS, "2026-10-21", "09:59").ok, false);
    assert.deepEqual(checkHours(HOURS, "2026-10-25", "12:00"), { ok: false, reason: "closed", day: "sun" });
    assert.equal(checkHours(HOURS, "2026-10-23", "13:00").ok, false, "Friday prayer break");
    assert.equal(checkHours(HOURS, "2026-10-23", "15:00").ok, true);
    assert.equal(checkHours(null, "2026-10-25", "03:00").ok, true);
    assert.equal(checkHours("Mon-Fri 9-5", "2026-10-25", "03:00").ok, true, "a sentence cannot be judged");
    assert.equal(checkHours({ mon: [["00:00", "24:00"]] }, "2026-10-19", "23:59").ok, true);
  });

  test("a date and time written for a person, in both languages", () => {
    assert.equal(formatDateTime("2026-10-21T17:00", "en"), "Wednesday, 21 October 2026 at 5:00 pm");
    assert.match(formatDateTime("2026-10-21T17:00", "ur"), /2026/);
    assert.equal(formatDateTime("nonsense", "en"), "nonsense");
  });
});

describe("validateValue", () => {
  const phone = getField("phone");
  const name = getField("name");
  const service = getField("service");
  const when = getField("datetime");
  const age = getField("age");

  test("a phone number is stored in international form and shown locally", () => {
    assert.deepEqual(validateValue(phone, "0300 1234567", ctx()), { ok: true, value: "+923001234567", display: "03001234567" });
    assert.equal(validateValue(phone, "12", ctx()).reason, "invalid_phone");
    assert.equal(validateValue(phone, "  ", ctx()).reason, "empty");
  });

  test("a name needs a letter and is clipped to its limit", () => {
    assert.equal(validateValue(name, "Ahmed Khan", ctx()).value, "Ahmed Khan");
    assert.equal(validateValue(name, "احمد خان", ctx()).value, "احمد خان");
    assert.equal(validateValue(name, "12345", ctx()).reason, "invalid_name");
    assert.equal(validateValue(name, "x".repeat(500), ctx()).value.length, 80);
  });

  test("a number is range-checked", () => {
    assert.equal(validateValue(age, "34", ctx()).value, "34");
    assert.deepEqual(validateValue(age, "200", ctx()), { ok: false, reason: "out_of_range", vars: { min: 0, max: 120 } });
    assert.equal(validateValue(age, "old", ctx()).reason, "not_a_number");
  });

  test("a choice resolves to the owner's option id and shows its label in the call's language", () => {
    const r = validateValue(service, "root canal please", ctx({ language: "ur" }));
    assert.deepEqual([r.ok, r.value, r.display], [true, "root_canal", "روٹ کینال"]);
    assert.equal(validateValue(service, "braces", ctx()).reason, "not_an_option");
  });

  test("a choice with no list defined is free text", () => {
    const empty = ctx({ config: { ...config(), services: [] } });
    assert.equal(validateValue(service, "Braces", empty).value, "Braces");
  });

  test("a date and time: the future, inside opening hours, in a real calendar", () => {
    assert.equal(validateValue(when, "2026-10-21T17:00", ctx()).value, "2026-10-21T17:00");
    assert.equal(validateValue(when, "2026-10-21T09:00", ctx()).reason, "in_past", "it is already 10:00");
    assert.equal(validateValue(when, "2026-10-20T11:00", ctx()).reason, "in_past");
    assert.deepEqual(validateValue(when, "2026-10-25T11:00", ctx()), { ok: false, reason: "closed", vars: { day: "sun" } });
    assert.equal(validateValue(when, "2026-10-22T22:00", ctx()).reason, "closed");
    assert.equal(validateValue(when, "2027-12-01T11:00", ctx()).reason, "too_far");
    for (const bad of ["tomorrow", "2026-02-30T10:00", "2026-10-21T25:00", "2026-10-21"]) assert.equal(validateValue(when, bad, ctx()).reason, "invalid_datetime", bad);
  });

  test("with no hours on record any future time is accepted", () => {
    assert.equal(validateValue(when, "2026-10-25T03:00", ctx({ hours: null })).ok, true);
  });

  test("a yes/no custom field", () => {
    const def = { id: "c_parking", type: "yesno" };
    assert.equal(validateValue(def, "ji haan", ctx()).value, "yes");
    assert.equal(validateValue(def, "perhaps", ctx()).reason, "not_yes_no");
  });
});

describe("displayValue", () => {
  test("shows each stored value the way a person reads it", () => {
    assert.equal(displayValue(getField("phone"), "+923001234567", ctx()), "03001234567");
    assert.equal(displayValue(getField("service"), "scaling", ctx({ language: "ur" })), "صفائی اور پالش");
    assert.equal(displayValue(getField("service"), "gone", ctx()), "gone", "a removed option shows its stored id, not nothing");
    assert.equal(displayValue(getField("datetime"), "2026-10-21T17:00", ctx()), "Wednesday, 21 October 2026 at 5:00 pm");
    assert.equal(displayValue(getField("name"), "Ahmed", ctx()), "Ahmed");
    assert.equal(displayValue(getField("name"), "", ctx()), "");
  });
});
