import { choiceOptions } from "./config";
import { pick } from "./catalog";

/**
 * CHECKING WHAT A CUSTOMER SAID BEFORE IT IS STORED — pure, no I/O.
 *
 * The model never decides that a phone number is a phone number or that Tuesday at nine is
 * inside opening hours: it hears the customer, and this file judges what it heard (§6.11 —
 * the model never silently changes tenant data). Every function here takes what was
 * UNDERSTOOD (a string from the extractor, or from a deterministic parse of the message)
 * and returns either a clean, normalised value or a REASON the engine can turn into "I
 * couldn't use that, could you say it again?".
 *
 * It exists in two scripts at once. Pakistani callers write digits as 0300, ۰۳۰۰ or ٠٣٠٠,
 * speak them as "zero three zero zero" or "صفر تین صفر صفر", and mix all of that in one
 * number, so the first step of nearly everything is `normalizeDigits`.
 */

const ARABIC_INDIC = /[٠-٩]/g; // U+0660..0669
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g; // U+06F0..06F9 (what Urdu keyboards type)

/** Eastern Arabic-Indic and Urdu digits to ASCII; everything else untouched. */
export function normalizeDigits(text) {
  return String(text ?? "")
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** One digit, as a word, in every spelling a caller uses (English, Urdu script, Roman Urdu). */
const DIGIT_WORDS = new Map(
  Object.entries({
    0: "zero sifar sifr صفر",
    1: "one aik ek ایک",
    2: "two do دو",
    3: "three teen تین",
    4: "four char chaar چار",
    5: "five paanch panch پانچ",
    6: "six chhe che chay چھ",
    7: "seven saat سات",
    8: "eight aath ath آٹھ",
    9: "nine nau نو",
  }).flatMap(([digit, words]) => words.split(" ").map((w) => [w, digit]))
);

const WORD_DIGIT_URDU = ["صفر", "ایک", "دو", "تین", "چار", "پانچ", "چھ", "سات", "آٹھ", "نو"];
const WORD_DIGIT_EN = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "03001234567" -> "zero three zero zero…" / "صفر تین صفر صفر…", for a voice to read digit by digit. */
export function digitsAsWords(digits, language) {
  const table = language === "ur" ? WORD_DIGIT_URDU : WORD_DIGIT_EN;
  return String(digits ?? "")
    .replace(/\D/g, "")
    .split("")
    .map((d) => table[Number(d)])
    .join(" ");
}

/**
 * Find a phone number in free text: the longest run of digits and digit WORDS with at least
 * seven digits. "my number is zero three double..."-style speech is not attempted ("double"
 * is ambiguous across three languages); what recognisers actually emit for a spoken number
 * is digits, or one digit word per digit.
 *
 * @param {string} text
 * @returns {string|null} the digits (and a leading +), or null
 */
export function findPhoneInText(text) {
  const tokens = normalizeDigits(text).split(/[\s,;:.،۔!?()/-]+/).filter(Boolean);
  let best = "";
  let run = "";
  const flush = () => {
    if (run.replace(/\D/g, "").length > best.replace(/\D/g, "").length) best = run;
    run = "";
  };
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (/^\+?\d+$/.test(token)) run += token;
    else if (DIGIT_WORDS.has(lower)) run += DIGIT_WORDS.get(lower);
    else flush();
  }
  flush();
  return best.replace(/\D/g, "").length >= 7 ? best : null;
}

/**
 * A phone number, in international form.
 *
 * Defaults to Pakistan (the market): 0300-1234567, 300 1234567, 92 300 1234567,
 * +92 300 1234567 and 0092… are all the same number; so is a landline 021-35551234.
 * Anything with a "+" or "00" prefix is taken as international and only length-checked.
 *
 * @param {string} raw
 * @param {{region?: "PK"}} [options]
 * @returns {{ok: true, value: string, local: string}|{ok: false, reason: string}}
 */
export function normalizePhone(raw, { region = "PK" } = {}) {
  const text = normalizeDigits(raw).trim();
  const international = text.startsWith("+");
  let digits = text.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "invalid_phone" };

  if (international || digits.startsWith("00")) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.length < 8 || digits.length > 15) return { ok: false, reason: "invalid_phone" };
    return finish(digits);
  }

  if (region === "PK") {
    if (digits.startsWith("920")) digits = `92${digits.slice(3)}`; // 92 0300…: a stray trunk zero
    if (digits.startsWith("92") && digits.length >= 11 && digits.length <= 12) return finish(digits);
    if (digits.startsWith("0") && digits.length >= 10 && digits.length <= 11) return finish(`92${digits.slice(1)}`);
    if (digits.startsWith("3") && digits.length === 10) return finish(`92${digits}`);
  }
  return { ok: false, reason: "invalid_phone" };

  function finish(all) {
    const value = `+${all}`;
    const local = region === "PK" && all.startsWith("92") ? `0${all.slice(2)}` : value;
    return { ok: true, value, local };
  }
}

/** Spoken "at" / "dot" forms in three spellings, folded back into an address. */
export function normalizeEmail(raw) {
  const text = String(raw ?? "")
    .toLowerCase()
    .replace(/\s+(at the rate of|at)\s+/g, "@")
    .replace(/\s*(ایٹ دی ریٹ|ایٹ)\s*/g, "@")
    .replace(/\s+(dot|point)\s+/g, ".")
    .replace(/\s*(ڈاٹ|ڈوٹ)\s*/g, ".")
    .replace(/\s+underscore\s+/g, "_")
    .replace(/\s+/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text) || text.length > 120) return { ok: false, reason: "invalid_email" };
  return { ok: true, value: text };
}

/** The first whole number in a message, digits or digit words; null when there is none. */
export function parseNumber(raw) {
  const text = normalizeDigits(raw);
  const match = /-?\d+/.exec(text);
  if (match) return Number(match[0]);
  for (const token of text.toLowerCase().split(/[\s,.!?،۔]+/)) {
    if (DIGIT_WORDS.has(token) && token !== "do") return Number(DIGIT_WORDS.get(token));
  }
  return null;
}

const YES_WORDS = new Set("yes yeah yep yup sure ok okay correct right true haan han bilkul theek thik sahi ہاں بالکل ٹھیک صحیح درست".split(" "));
const NO_WORDS = new Set("no nope nah false nahi nahin nai na نہیں نہ غلط".split(" "));
/** Politeness that can sit in front of either answer: "ji nahi" is no, "ji haan" is yes. */
const FILLER_WORDS = new Set("ji jee please pls جی".split(" "));

/** @returns {"yes"|"no"|null} */
export function parseYesNo(raw) {
  const tokens = String(raw ?? "")
    .toLowerCase()
    .split(/[\s.!۔,،?؟]+/)
    .filter(Boolean)
    .filter((t) => !FILLER_WORDS.has(t));
  const first = tokens[0];
  if (!first) return null;
  // "theek nahi hai", "sahi nahi": the first word agrees, the next one takes it back.
  if (YES_WORDS.has(first) && NO_WORDS.has(tokens[1] ?? "")) return "no";
  if (YES_WORDS.has(first)) return "yes";
  if (NO_WORDS.has(first)) return "no";
  return null;
}

const comparable = (text) =>
  String(text ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Which of the owner's options did the customer mean? An exact id or label wins; otherwise
 * the one option whose label the answer contains (or the other way round, for words of three
 * letters or more). Two candidates is ambiguous and matches nothing — the engine asks again.
 *
 * @returns {{id: string, label: {en?: string, ur?: string}}|null}
 */
export function matchOption(raw, options) {
  const wanted = comparable(raw);
  if (!wanted) return null;
  const exact = options.find((o) => o.id === raw || comparable(o.label?.en) === wanted || comparable(o.label?.ur) === wanted);
  if (exact) return exact;

  const labels = (o) => [o.label?.en, o.label?.ur].map(comparable).filter((c) => c.length >= 3);
  // The answer CONTAINS a label ("I need scaling and polishing please"): if several are
  // contained, the longest wins ("hair colour long" beats "hair colour") — unless two tie.
  const inside = options
    .map((o) => ({ o, len: Math.max(0, ...labels(o).filter((c) => wanted.includes(c)).map((c) => c.length)) }))
    .filter((x) => x.len > 0)
    .sort((a, b) => b.len - a.len);
  if (inside.length) return inside.length === 1 || inside[0].len > inside[1].len ? inside[0].o : null;

  // The answer is a PART of one label ("canal" for "Root canal"): only if that is unambiguous.
  if (wanted.length < 3) return null;
  const partial = options.filter((o) => labels(o).some((c) => c.includes(wanted)));
  return partial.length === 1 ? partial[0] : null;
}

// ── time ────────────────────────────────────────────────────────────────

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * The wall-clock date and time right now in a time zone, as plain strings. An unknown zone
 * degrades to UTC rather than throwing: a typo in a business's settings must not fail a call.
 *
 * @param {number} nowMs
 * @param {string} timezone IANA name
 * @returns {{date: string, time: string, day: string}} "2026-10-21", "17:05", "wed"
 */
export function zonedNow(nowMs, timezone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
  } catch {
    return zonedNow(nowMs, "UTC");
  }
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, time: `${get("hour")}:${get("minute")}`, day: dayOf(date) };
}

/** "2026-10-21" -> "wed" (a calendar fact, independent of any time zone). */
export function dayOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
};

/**
 * Is a local time inside the business's opening hours?
 *
 * `hours` is the free-form JSON the dashboard writes ({ mon: [["09:00","17:00"]], sun: [] },
 * prompt.js formatHours). Anything else — null, a sentence — means "no hours on record", and
 * then nothing can be judged closed: the request goes to the team, who know better.
 *
 * @returns {{ok: true}|{ok: false, reason: "closed", day: string}}
 */
export function checkHours(hours, date, time) {
  if (!hours || typeof hours !== "object" || Array.isArray(hours)) return { ok: true };
  const day = dayOf(date);
  if (!(day in hours)) return { ok: true };
  const ranges = Array.isArray(hours[day]) ? hours[day] : [];
  const at = toMinutes(time);
  const end = (value) => (value === "24:00" ? 24 * 60 : toMinutes(value));
  const open = ranges.some((r) => Array.isArray(r) && at >= toMinutes(r[0]) && at < end(r[1]));
  return open ? { ok: true } : { ok: false, reason: "closed", day };
}

/** Longest the agent will take a request for. A date a year out is a mishearing. */
const MAX_DAYS_AHEAD = 365;

const utcDay = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const daysBetween = (from, to) => Math.round((utcDay(to) - utcDay(from)) / 86_400_000);

/**
 * "2026-10-21T17:00" for a person: "Wednesday 21 October 2026, 5:00 PM" / the Urdu equivalent.
 * The components are formatted as UTC so the wall-clock time the customer asked for is
 * printed exactly, with no time-zone arithmetic.
 */
export function formatDateTime(value, language) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value));
  if (!m) return String(value);
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return new Intl.DateTimeFormat(language === "ur" ? "ur-PK" : "en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** "2026-10-21" for a person: "Wednesday, 21 October 2026" / the Urdu equivalent. */
export function formatDate(value, language) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return String(value);
  return new Intl.DateTimeFormat(language === "ur" ? "ur-PK" : "en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
}

/**
 * @typedef {object} ValidationContext
 * @property {object} config      the tenant's normalized collect config (options for choices)
 * @property {string} timezone
 * @property {unknown} hours
 * @property {number} nowMs
 * @property {"en"|"ur"} language the language values are shown in
 */

/**
 * Judge one value for one field.
 *
 * @param {object} def a field definition (catalog.js / config.js fieldDef)
 * @param {unknown} raw what was understood
 * @param {ValidationContext} ctx
 * @returns {{ok: true, value: string, display: string}|{ok: false, reason: string, vars?: object}}
 */
export function validateValue(def, raw, ctx) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  const language = ctx.language === "ur" ? "ur" : "en";

  switch (def.type) {
    case "phone": {
      const phone = normalizePhone(text);
      return phone.ok ? { ok: true, value: phone.value, display: phone.local } : phone;
    }
    case "email": {
      const email = normalizeEmail(text);
      return email.ok ? { ok: true, value: email.value, display: email.value } : email;
    }
    case "number": {
      const n = parseNumber(text);
      if (n === null || !Number.isFinite(n)) return { ok: false, reason: "not_a_number" };
      const min = def.min ?? 0;
      const max = def.max ?? 1_000_000;
      if (n < min || n > max) return { ok: false, reason: "out_of_range", vars: { min, max } };
      return { ok: true, value: String(n), display: String(n) };
    }
    case "yesno": {
      const answer = parseYesNo(text);
      if (!answer) return { ok: false, reason: "not_yes_no" };
      return { ok: true, value: answer, display: answer === "yes" ? (language === "ur" ? "ہاں" : "Yes") : language === "ur" ? "نہیں" : "No" };
    }
    case "choice": {
      const options = choiceOptions(ctx.config, def);
      if (!options.length) return clip(text, def.max ?? 120); // the owner has not listed any: free text
      const option = matchOption(text, options);
      if (!option) return { ok: false, reason: "not_an_option" };
      return { ok: true, value: option.id, display: pick(option.label, language) };
    }
    case "datetime": {
      const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text);
      if (!m) return { ok: false, reason: "invalid_datetime" };
      const [, y, mo, d, h, mi] = m;
      const probe = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
      if (probe.getUTCFullYear() !== +y || probe.getUTCMonth() !== +mo - 1 || probe.getUTCDate() !== +d || +h > 23 || +mi > 59) {
        return { ok: false, reason: "invalid_datetime" };
      }
      const date = `${y}-${mo}-${d}`;
      const time = `${h}:${mi}`;
      const now = zonedNow(ctx.nowMs, ctx.timezone);
      if (date < now.date || (date === now.date && time < now.time)) return { ok: false, reason: "in_past" };
      if (daysBetween(now.date, date) > MAX_DAYS_AHEAD) return { ok: false, reason: "too_far" };
      const open = checkHours(ctx.hours, date, time);
      if (!open.ok) return { ok: false, reason: "closed", vars: { day: open.day } };
      return { ok: true, value: `${date}T${time}`, display: formatDateTime(`${date}T${time}`, language) };
    }
    case "longtext":
    case "text":
    default: {
      if (def.id === "name" && !/\p{L}/u.test(text)) return { ok: false, reason: "invalid_name" };
      return clip(text, def.max ?? (def.type === "longtext" ? 500 : 120));
    }
  }
}

function clip(text, max) {
  const value = text.replace(/\s+/g, " ").slice(0, max);
  return { ok: true, value, display: value };
}

/**
 * A stored value shown to a person (the read-back, the records list). Choices show the
 * owner's label in the language asked for; everything else is shown as stored, with dates
 * written out and phone numbers in their local form.
 */
export function displayValue(def, value, ctx) {
  const language = ctx?.language === "ur" ? "ur" : "en";
  if (value == null || value === "") return "";
  switch (def.type) {
    case "choice": {
      const option = choiceOptions(ctx?.config, def).find((o) => o.id === value);
      return option ? pick(option.label, language) : String(value);
    }
    case "datetime":
      return formatDateTime(value, language);
    case "phone": {
      const p = normalizePhone(value);
      return p.ok ? p.local : String(value);
    }
    case "yesno":
      return value === "yes" ? (language === "ur" ? "ہاں" : "Yes") : language === "ur" ? "نہیں" : "No";
    default:
      return String(value);
  }
}
