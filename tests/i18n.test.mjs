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
    assert.equal(resolveLocale({ requested: "it", acceptLanguage: "en", fallback: "en" }), "it");
    assert.equal(resolveLocale({ acceptLanguage: "it-IT,it;q=0.9,en;q=0.8", fallback: "en" }), "it");
    assert.equal(resolveLocale({ acceptLanguage: "fr", fallback: "it" }), "it");
  });

  test("a requested locale outside the tenant's enabled set is ignored", () => {
    assert.equal(resolveLocale({ requested: "it", acceptLanguage: "it", enabled: ["en"], fallback: "en" }), "en");
  });

  test("enabled UNDEFINED/null = unrestricted (the UI-language case), EMPTY = default only", () => {
    // The regression this guards: every dashboard request silently became English
    // because "no restriction" was read as "only English".
    assert.equal(resolveLocale({ requested: "it", enabled: undefined, fallback: "en" }), "it");
    assert.equal(resolveLocale({ requested: "it", enabled: null, fallback: "en" }), "it");
    assert.equal(resolveLocale({ requested: "it", acceptLanguage: "it", enabled: [], fallback: "it" }), "en");
  });

  test("unsupported/dormant locales are filtered out of the pool", () => {
    assert.equal(resolveLocale({ requested: "ar", enabled: ["ar", "it"], fallback: "en" }), "it");
    assert.equal(resolveLocale({ requested: "ar", fallback: "en" }), "en", "ar is dormant");
    assert.equal(resolveLocale({ enabled: ["ar", "ur"], fallback: "ar" }), "en", "nothing active left → default");
  });

  test("a single-language tenant is always served that language", () => {
    assert.equal(resolveLocale({ acceptLanguage: "en", enabled: ["it"], fallback: "en" }), "it");
  });

  test("Accept-Language is scanned in quality order until something is enabled", () => {
    assert.equal(resolveLocale({ acceptLanguage: "fr,de;q=0.9,it;q=0.5,en;q=0.4", fallback: "en" }), "it");
    assert.equal(resolveLocale({ acceptLanguage: "it;q=0,en;q=0.1", fallback: "it" }), "en", "q=0 means refused");
  });

  test("with no match the explicit default wins over list order", () => {
    assert.equal(resolveLocale({ fallback: undefined }), DEFAULT_LOCALE);
    assert.equal(resolveLocale({ acceptLanguage: "fr", fallback: "fr" }), DEFAULT_LOCALE);
  });
});

describe("parseAcceptLanguage", () => {
  test("sorts by quality, drops regions, lowercases", () => {
    assert.deepEqual(parseAcceptLanguage("it-IT,it;q=0.9,en;q=0.8"), ["it", "it", "en"]);
    assert.deepEqual(parseAcceptLanguage("EN-gb;q=0.3, IT;q=0.7"), ["it", "en"]);
  });

  test("garbage in, nothing out", () => {
    assert.deepEqual(parseAcceptLanguage(undefined), []);
    assert.deepEqual(parseAcceptLanguage(""), []);
    assert.deepEqual(parseAcceptLanguage(42), []);
    assert.deepEqual(parseAcceptLanguage("it;q=abc,en"), ["en"], "an unparsable q counts as refused");
  });
});

describe("reply language vs locale (§7)", () => {
  test("'auto' is a reply language but never a locale", () => {
    for (const v of ["en", "it", "auto"]) assert.equal(isReplyLanguage(v), true, v);
    for (const v of ["ar", "", undefined, null, 1]) assert.equal(isReplyLanguage(v), false, String(v));
    assert.equal(isSupportedLocale("auto"), false);
    assert.ok(!SUPPORTED_LOCALES.includes("auto"));
  });

  test("direction", () => {
    assert.equal(dirFor("ar"), "rtl");
    assert.equal(dirFor("en"), "ltr");
    assert.equal(isRTL("ur"), true);
  });
});

describe("t() — lookup, fallback, interpolation, plurals", () => {
  // Real catalogs carry no plural keys yet, so these tests plant synthetic ones and
  // remove them again. CATALOGS is the live object t() reads.
  const keys = {
    en: { "tx.greet": "Hello {name}, you have {count} items", "tx.items_one": "{count} item", "tx.items_other": "{count} items", "tx.only_en": "English only", "tx.num": "Total {n}" },
    it: { "tx.greet": "Ciao {name}, hai {count} elementi", "tx.items_one": "{count} elemento", "tx.items_other": "{count} elementi", "tx.num": "Totale {n}" },
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
    assert.equal(t({ locale: "it", key: "common:tx.num", vars: { n: 12345.5 } }), "Totale 12.345,5");
  });

  test("plural form comes from Intl.PluralRules and {count} is implicit", () => {
    assert.equal(t({ locale: "en", key: "common:tx.items", count: 1 }), "1 item");
    assert.equal(t({ locale: "en", key: "common:tx.items", count: 0 }), "0 items");
    assert.equal(t({ locale: "en", key: "common:tx.items", count: 5 }), "5 items");
    assert.equal(t({ locale: "it", key: "common:tx.items", count: 1 }), "1 elemento");
    assert.equal(t({ locale: "it", key: "common:tx.items", count: 3 }), "3 elementi");
  });

  test("a plural category the locale lacks falls back to `_other` IN THAT LOCALE, not English", () => {
    // Italian uses `many` for 1,000,000; only _one/_other exist here.
    assert.equal(t({ locale: "it", key: "common:tx.items", count: 1000000 }), "1.000.000 elementi");
  });

  test("a vars entry overrides the implicit count", () => {
    assert.equal(t({ locale: "en", key: "common:tx.items", count: 3, vars: { count: "three" } }), "three items");
  });

  test("a key missing from the locale falls back to English; an unsupported locale IS English", () => {
    assert.equal(t({ locale: "it", key: "common:tx.only_en" }), "English only");
    assert.equal(t({ locale: "fr", key: "common:tx.only_en" }), "English only");
    assert.equal(t({ locale: "ar", key: "common:tx.items", count: 1 }), "1 item", "dormant → English");
  });

  test("a missing key returns the key itself, never blank and never a throw", () => {
    assert.equal(t({ locale: "en", key: "common:no.such.key" }), "common:no.such.key");
    assert.equal(t({ locale: "en", key: "nocolon" }), "nocolon");
    assert.equal(t({ locale: "en", key: "common:" }), "common:");
    assert.equal(t({ locale: "en", key: undefined }), undefined);
  });

  test("translator() binds the locale", () => {
    const tr = translator("it");
    assert.equal(tr("common:tx.items", { count: 1 }), "1 elemento");
  });

  test("getCatalog merges over English so a gap never reaches the client blank", () => {
    assert.equal(getCatalog("it", ["common"]).common["tx.only_en"], "English only");
    assert.equal(getCatalog("it", ["common"]).common["tx.items_one"], "{count} elemento");
    assert.deepEqual(Object.keys(getCatalog("fr", ["common"])), ["common"]);
    assert.deepEqual(Object.keys(getCatalog("en", ["common", "nope"])), ["common"], "unknown namespaces are skipped");
  });
});

describe("real catalogs", () => {
  test("every active locale has a native language name for the switcher", () => {
    assert.equal(CATALOGS.it.common["language.it"], "Italiano");
    assert.equal(t({ locale: "it", key: "capabilities:book_appointment.label" }).length > 0, true);
  });
});
