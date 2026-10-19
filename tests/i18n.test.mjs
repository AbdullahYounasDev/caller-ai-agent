import "./helpers/no-db.mjs";
import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  t,
  translator,
  resolveLocale,
  parseAcceptLanguage,
  isReplyLanguage,
  isSupportedLocale,
  getCatalog,
  dirFor,
  isRTL,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
} from "@/lib/i18n";
import { CATALOGS } from "@/lib/i18n/catalogs";

describe("resolveLocale precedence", () => {
  test("an explicit choice beats Accept-Language beats the tenant default", () => {
    assert.equal(resolveLocale({ requested: "ur", acceptLanguage: "en", fallback: "en" }), "ur");
    assert.equal(resolveLocale({ acceptLanguage: "ur-PK,ur;q=0.9,en;q=0.8", fallback: "en" }), "ur");
    assert.equal(resolveLocale({ acceptLanguage: "fr", fallback: "ur" }), "ur");
  });

  test("a requested locale outside the tenant's enabled set is ignored", () => {
    assert.equal(resolveLocale({ requested: "ur", acceptLanguage: "ur", enabled: ["en"], fallback: "en" }), "en");
  });

  test("enabled UNDEFINED/null = unrestricted (the UI-language case), EMPTY = default only", () => {
    // The regression this guards: every dashboard request silently became English
    // because "no restriction" was read as "only English".
    assert.equal(resolveLocale({ requested: "ur", enabled: undefined, fallback: "en" }), "ur");
    assert.equal(resolveLocale({ requested: "ur", enabled: null, fallback: "en" }), "ur");
    assert.equal(resolveLocale({ requested: "ur", acceptLanguage: "ur", enabled: [], fallback: "ur" }), "en");
  });

  test("removed locales (Italian, Arabic) are filtered out of the pool", () => {
    assert.equal(resolveLocale({ requested: "it", enabled: ["it", "ur"], fallback: "en" }), "ur");
    assert.equal(resolveLocale({ requested: "it", fallback: "en" }), "en", "it is gone");
    assert.equal(resolveLocale({ requested: "ar", fallback: "en" }), "en", "ar is gone");
    assert.equal(resolveLocale({ enabled: ["ar", "it"], fallback: "ar" }), "en", "nothing active left → default");
  });

  test("a single-language tenant is always served that language", () => {
    assert.equal(resolveLocale({ acceptLanguage: "en", enabled: ["ur"], fallback: "en" }), "ur");
  });

  test("Accept-Language is scanned in quality order until something is enabled", () => {
    assert.equal(resolveLocale({ acceptLanguage: "fr,de;q=0.9,ur;q=0.5,en;q=0.4", fallback: "en" }), "ur");
    assert.equal(resolveLocale({ acceptLanguage: "ur;q=0,en;q=0.1", fallback: "ur" }), "en", "q=0 means refused");
  });

  test("with no match the explicit default wins over list order", () => {
    assert.equal(resolveLocale({ fallback: undefined }), DEFAULT_LOCALE);
    assert.equal(resolveLocale({ acceptLanguage: "fr", fallback: "fr" }), DEFAULT_LOCALE);
  });
});

describe("parseAcceptLanguage", () => {
  test("sorts by quality, drops regions, lowercases", () => {
    assert.deepEqual(parseAcceptLanguage("ur-PK,ur;q=0.9,en;q=0.8"), ["ur", "ur", "en"]);
    assert.deepEqual(parseAcceptLanguage("EN-gb;q=0.3, UR;q=0.7"), ["ur", "en"]);
  });

  test("garbage in, nothing out", () => {
    assert.deepEqual(parseAcceptLanguage(undefined), []);
    assert.deepEqual(parseAcceptLanguage(""), []);
    assert.deepEqual(parseAcceptLanguage(42), []);
    assert.deepEqual(parseAcceptLanguage("ur;q=abc,en"), ["en"], "an unparsable q counts as refused");
  });
});

describe("reply language vs locale (§7)", () => {
  test("the product speaks exactly two languages, and 'auto' is neither a reply language nor a locale", () => {
    assert.deepEqual([...SUPPORTED_LOCALES], ["en", "ur"]);
    for (const v of ["en", "ur"]) assert.equal(isReplyLanguage(v), true, v);
    for (const v of ["auto", "it", "ar", "", undefined, null, 1]) assert.equal(isReplyLanguage(v), false, String(v));
    assert.equal(isSupportedLocale("auto"), false);
    assert.equal(isSupportedLocale("it"), false);
    assert.ok(!SUPPORTED_LOCALES.includes("auto"));
  });

  test("direction", () => {
    assert.equal(dirFor("ur"), "rtl");
    assert.equal(dirFor("en"), "ltr");
    assert.equal(isRTL("ur"), true);
    assert.equal(isRTL("ar"), false, "Arabic is not an active locale");
  });
});

describe("t() — lookup, fallback, interpolation, plurals", () => {
  // Real catalogs carry no plural keys yet, so these tests plant synthetic ones and
  // remove them again. CATALOGS is the live object t() reads.
  const keys = {
    en: { "tx.greet": "Hello {name}, you have {count} items", "tx.items_one": "{count} item", "tx.items_other": "{count} items", "tx.only_en": "English only", "tx.num": "Total {n}" },
    ur: { "tx.greet": "{name}، آپ کے پاس {count} اشیاء ہیں", "tx.items_one": "{count} شے", "tx.items_other": "{count} اشیاء", "tx.num": "کل {n}" },
  };
  let warn;
  beforeEach(() => {
    for (const [loc, kv] of Object.entries(keys)) Object.assign(CATALOGS[loc].common, kv);
    warn = console.warn;
    console.warn = () => {};
  });
  afterEach(() => {
    for (const [loc, kv] of Object.entries(keys)) for (const k of Object.keys(kv)) delete CATALOGS[loc].common[k];
    console.warn = warn;
  });

  test("placeholders are interpolated; unknown ones are left visible", () => {
    assert.equal(t({ locale: "en", key: "common:tx.greet", vars: { name: "Ada", count: 2 } }), "Hello Ada, you have 2 items");
    assert.equal(t({ locale: "en", key: "common:tx.greet", vars: { name: "Ada" } }), "Hello Ada, you have {count} items");
    assert.equal(t({ locale: "en", key: "common:tx.greet", vars: { name: null, count: undefined } }), "Hello {name}, you have {count} items");
  });

  test("numbers are formatted for the locale", () => {
    assert.equal(t({ locale: "en", key: "common:tx.num", vars: { n: 12345.5 } }), "Total 12,345.5");
    assert.equal(t({ locale: "ur", key: "common:tx.num", vars: { n: 12345.5 } }), "کل 12,345.5");
  });

  test("plural form comes from Intl.PluralRules and {count} is implicit", () => {
    assert.equal(t({ locale: "en", key: "common:tx.items", count: 1 }), "1 item");
    assert.equal(t({ locale: "en", key: "common:tx.items", count: 0 }), "0 items");
    assert.equal(t({ locale: "en", key: "common:tx.items", count: 5 }), "5 items");
    assert.equal(t({ locale: "ur", key: "common:tx.items", count: 1 }), "1 شے");
    assert.equal(t({ locale: "ur", key: "common:tx.items", count: 3 }), "3 اشیاء");
  });

  test("a plural category the locale lacks falls back to `_other` IN THAT LOCALE, not English", () => {
    // Only _one/_other exist here, and 0 / large counts must land on _other.
    assert.equal(t({ locale: "ur", key: "common:tx.items", count: 1000000 }), "1,000,000 اشیاء");
  });

  test("a vars entry overrides the implicit count", () => {
    assert.equal(t({ locale: "en", key: "common:tx.items", count: 3, vars: { count: "three" } }), "three items");
  });

  test("a key missing from the locale falls back to English; an unsupported locale IS English", () => {
    assert.equal(t({ locale: "ur", key: "common:tx.only_en" }), "English only");
    assert.equal(t({ locale: "fr", key: "common:tx.only_en" }), "English only");
    assert.equal(t({ locale: "it", key: "common:tx.items", count: 1 }), "1 item", "removed locale → English");
  });

  test("a missing key returns the key itself, never blank and never a throw", () => {
    assert.equal(t({ locale: "en", key: "common:no.such.key" }), "common:no.such.key");
    assert.equal(t({ locale: "en", key: "nocolon" }), "nocolon");
    assert.equal(t({ locale: "en", key: "common:" }), "common:");
    assert.equal(t({ locale: "en", key: undefined }), undefined);
  });

  test("translator() binds the locale", () => {
    const tr = translator("ur");
    assert.equal(tr("common:tx.items", { count: 1 }), "1 شے");
  });

  test("getCatalog merges over English so a gap never reaches the client blank", () => {
    assert.equal(getCatalog("ur", ["common"]).common["tx.only_en"], "English only");
    assert.equal(getCatalog("ur", ["common"]).common["tx.items_one"], "{count} شے");
    assert.deepEqual(Object.keys(getCatalog("fr", ["common"])), ["common"]);
    assert.deepEqual(Object.keys(getCatalog("en", ["common", "nope"])), ["common"], "unknown namespaces are skipped");
  });
});

describe("real catalogs", () => {
  test("every active locale has a native language name for the switcher", () => {
    assert.equal(CATALOGS.ur.common["language.ur"], "اردو");
    assert.equal(CATALOGS.en.common["language.en"], "English");
    assert.equal(t({ locale: "ur", key: "capabilities:book_appointment.label" }).length > 0, true);
  });
});
