#!/usr/bin/env node
/**
 * Fails the build when translation catalogs drift out of sync.
 *
 * Without this, adding a key to `en` and forgetting the other one is
 * invisible: the fallback quietly serves English to an Urdu customer and
 * nobody finds out until one of them mentions it. Translation rot is silent by
 * nature, so it needs a mechanical check.
 *
 * WHAT IT CHECKS
 *   - every locale has every namespace file
 *   - every locale has every BASE key that `en` has, and no extras
 *   - plural keys are compared by base name, not exact form. A language may
 *     legitimately have more plural categories than English's `_one/_other`, so
 *     demanding identical key sets would make a correct translation fail. What IS
 *     required is that every plural key has at least `_other`, the category every
 *     language has.
 *   - placeholders match: if `en` says {businessName} and Urdu says
 *     {کاروبار}, the variable silently renders as literal text.
 *
 * Run: npm run i18n:check
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
const SOURCE_LOCALE = "en";

// ACTIVE locales: English (the source) and Urdu — the only two the product ships.
// Add a code here, to lib/i18n and to catalogs.js to bring another one under enforcement.
const ACTIVE_LOCALES = ["en", "ur"];

// CLDR plural categories. A key ending in one of these is a plural form.
const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];

const problems = [];

function baseKey(key) {
  const index = key.lastIndexOf("_");
  if (index === -1) return { base: key, category: null };

  const suffix = key.slice(index + 1);
  if (!PLURAL_SUFFIXES.includes(suffix)) return { base: key, category: null };

  return { base: key.slice(0, index), category: suffix };
}

function placeholders(value) {
  return new Set([...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

function readCatalog(locale, namespace) {
  const path = join(ROOT, locale, namespace);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    problems.push(`${locale}/${namespace}: invalid JSON — ${err.message}`);
    return null;
  }
}

/** Group a catalog's keys into { base -> { categories:Set, values:Map } }. */
function index(catalog) {
  const map = new Map();
  for (const [key, value] of Object.entries(catalog)) {
    const { base, category } = baseKey(key);
    if (!map.has(base)) map.set(base, { categories: new Set(), values: new Map() });
    const entry = map.get(base);
    entry.categories.add(category);
    entry.values.set(key, value);
  }
  return map;
}

const onDisk = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const locales = onDisk.filter((l) => ACTIVE_LOCALES.includes(l));
const dormant = onDisk.filter((l) => !ACTIVE_LOCALES.includes(l));

if (!locales.includes(SOURCE_LOCALE)) {
  console.error(`✗ source locale "${SOURCE_LOCALE}" not found in ${ROOT}`);
  process.exit(1);
}

const namespaces = readdirSync(join(ROOT, SOURCE_LOCALE)).filter((f) => f.endsWith(".json"));

for (const namespace of namespaces) {
  const source = readCatalog(SOURCE_LOCALE, namespace);
  if (!source) {
    problems.push(`${SOURCE_LOCALE}/${namespace}: missing or unreadable`);
    continue;
  }
  const sourceIndex = index(source);

  for (const locale of locales) {
    if (locale === SOURCE_LOCALE) continue;

    const target = readCatalog(locale, namespace);
    if (!target) {
      problems.push(`${locale}/${namespace}: file is missing`);
      continue;
    }
    const targetIndex = index(target);

    for (const [base, sourceEntry] of sourceIndex) {
      const targetEntry = targetIndex.get(base);
      if (!targetEntry) {
        problems.push(`${locale}/${namespace}: missing key "${base}"`);
        continue;
      }

      const isPlural = !sourceEntry.categories.has(null);
      if (isPlural && !targetEntry.values.has(`${base}_other`)) {
        problems.push(
          `${locale}/${namespace}: plural key "${base}" has no "_other" form ` +
            `(every language has an "other" category)`
        );
      }

      // Placeholder parity, checked against any one source form — all forms of
      // a plural key use the same variables.
      const sourceVars = placeholders([...sourceEntry.values.values()][0]);
      for (const [key, value] of targetEntry.values) {
        const targetVars = placeholders(value);
        const extra = [...targetVars].filter((v) => !sourceVars.has(v));
        if (extra.length) {
          problems.push(`${locale}/${namespace}: "${key}" has unknown {${extra.join("}, {")}}`);
        }

        // A plural form may legitimately OMIT {count}, because many languages
        // encode the number in the word itself: Arabic's dual "رسالتان" already
        // means "two messages", and forcing "{count} رسالتان" would render
        // "2 two messages". So only non-count variables are required here.
        //
        // For a non-plural key, a missing placeholder is always a bug — it means
        // the value renders as literal text the customer was never meant to see.
        const required = isPlural
          ? [...sourceVars].filter((v) => v !== "count")
          : [...sourceVars];
        const missing = required.filter((v) => !targetVars.has(v));
        if (missing.length) {
          problems.push(`${locale}/${namespace}: "${key}" is missing {${missing.join("}, {")}}`);
        }
      }
    }

    for (const base of targetIndex.keys()) {
      if (!sourceIndex.has(base)) {
        problems.push(
          `${locale}/${namespace}: key "${base}" does not exist in ${SOURCE_LOCALE} ` +
            `(add it there first, or delete it here)`
        );
      }
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} translation problem(s):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("");
  process.exit(1);
}

const keyCount = namespaces.reduce(
  (sum, ns) => sum + Object.keys(readCatalog(SOURCE_LOCALE, ns) ?? {}).length,
  0
);
console.log(
  `✓ locales in sync — ${locales.length} active locales × ${namespaces.length} namespaces (${keyCount} source keys)`
);
if (dormant.length) {
  console.log(`  dormant, not checked: ${dormant.join(", ")}`);
}
