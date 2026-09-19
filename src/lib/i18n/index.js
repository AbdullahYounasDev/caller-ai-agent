import { CATALOGS } from "./catalogs";

/**
 * Minimal i18n. Key → string, with interpolation, CLDR plurals and RTL support.
 *
 * WHY NOT next-intl / i18next: the chat widget ships as a standalone bundle onto
 * other people's websites, where every kilobyte is a cost we impose on someone
 * else's page load. A framework-coupled i18n library brings a provider tree, a
 * loader and a plugin system we don't need. This file is the whole system, and
 * the widget can import the one function it uses.
 *
 * THE RULES:
 *   - `en` is the source of truth. Every other locale is measured against it.
 *   - A key missing from a locale falls back to `en` — never to a blank string,
 *     and never to the raw key, because a customer seeing "widget.input.send"
 *     in a chat window is worse than seeing English.
 *   - Key parity is enforced by `npm run i18n:check`, so the fallback path
 *     should be unreachable in practice. It exists for the case where it isn't.
 */

export const SUPPORTED_LOCALES = ["en", "it", "ar", "ur"];
export const DEFAULT_LOCALE = "en";
export const RTL_LOCALES = ["ar", "ur"];

/** @param {string} locale */
export function isRTL(locale) {
  return RTL_LOCALES.includes(locale);
}

/**
 * The `dir` attribute for a locale. Direction is a DOCUMENT concern, not a
 * styling one: setting `dir` lets the browser handle bidirectional text, cursor
 * movement and selection correctly. Flipping things with CSS alone does not.
 * @param {string} locale
 */
export function dirFor(locale) {
  return isRTL(locale) ? "rtl" : "ltr";
}

/** @param {unknown} locale */
export function isSupportedLocale(locale) {
  return typeof locale === "string" && SUPPORTED_LOCALES.includes(locale);
}

/**
 * Translate.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.key  "namespace:key.path" — e.g. "widget:input.send"
 * @param {Record<string, string|number>} [args.vars] interpolated into {placeholders}
 * @param {number} [args.count] selects a plural form; also available as {count}
 * @returns {string}
 */
export function t({ locale, key, vars = {}, count }) {
  const safeLocale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const [namespace, path] = splitKey(key);
  if (!namespace || !path) return key;

  const resolvedKey = count === undefined ? path : pluralKey(safeLocale, path, count);

  let template =
    lookup(safeLocale, namespace, resolvedKey) ??
    // Plural category missing in this locale (e.g. a translator filled in
    // `_other` but not `_few`): fall back to `_other` before leaving the locale
    // entirely. A grammatically imperfect sentence in the right language beats
    // a correct one in the wrong language.
    (count === undefined ? null : lookup(safeLocale, namespace, `${path}_other`)) ??
    lookup(DEFAULT_LOCALE, namespace, resolvedKey) ??
    (count === undefined ? null : lookup(DEFAULT_LOCALE, namespace, `${path}_other`));

  if (template == null) {
    // Should be unreachable — `npm run i18n:check` fails the build on a missing
    // key. Loud in dev, and degrades to the key rather than throwing mid-reply.
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[i18n] missing translation: ${key} (locale: ${safeLocale})`);
    }
    return key;
  }

  return interpolate(template, count === undefined ? vars : { count, ...vars }, safeLocale);
}

/**
 * Bind a locale once and translate many times — what a component or a request
 * handler actually wants.
 *
 *   const tr = translator("ar");
 *   tr("widget:input.send");
 *
 * @param {string} locale
 */
export function translator(locale) {
  return (key, options = {}) => t({ locale, key, ...options });
}

function splitKey(key) {
  if (typeof key !== "string") return [null, null];
  const index = key.indexOf(":");
  if (index === -1) return [null, null];
  return [key.slice(0, index), key.slice(index + 1)];
}

function lookup(locale, namespace, path) {
  return CATALOGS[locale]?.[namespace]?.[path] ?? null;
}

/**
 * Pick the plural form using the platform's CLDR data.
 *
 * This is why `Intl.PluralRules` rather than `count === 1 ? a : b`: Arabic has
 * SIX plural categories (zero, one, two, few, many, other) and the naive check
 * gets almost every Arabic sentence wrong. Urdu and English have two, Italian
 * has three. Letting Intl decide means each translator writes the forms their
 * own language actually has.
 */
function pluralKey(locale, path, count) {
  const category = new Intl.PluralRules(locale).select(count);
  return `${path}_${category}`;
}

/**
 * Replace {placeholders}, formatting numbers for the locale.
 *
 * ON ARABIC NUMERALS — a product decision, not a bug. Our locale codes have no
 * region, and CLDR's default numbering system for bare "ar" is Latin digits:
 *   Intl.NumberFormat("ar").format(1234)    -> "1,234"
 *   Intl.NumberFormat("ar-EG").format(1234) -> "١٬٢٣٤"
 * So today Arabic customers see Latin digits. That is correct for much of the
 * Gulf and the Maghreb, and wrong-looking in Egypt. If a tenant needs
 * Arabic-Indic numerals, the fix is region-aware locales (ar-EG) rather than
 * hardcoding a numbering system here — don't "fix" it globally without asking,
 * it would look wrong for the majority.
 *
 * Unknown placeholders are left as-is: a visible "{businessName}" in dev is a
 * bug report, whereas silently deleting it hides the missing variable.
 */
function interpolate(template, vars, locale) {
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = vars[name];
    if (value === undefined || value === null) return match;
    return typeof value === "number"
      ? new Intl.NumberFormat(locale).format(value)
      : String(value);
  });
}

/**
 * Pick the best locale for a request.
 *
 * Priority, most specific first:
 *   1. an explicit choice the user made (a language switcher)
 *   2. the host page / browser's Accept-Language
 *   3. the tenant's configured default
 *
 * Every candidate is checked against what the TENANT has enabled — a business
 * that only operates in English and Arabic must not get its agent answering in
 * Urdu just because a visitor's browser asked.
 *
 * @param {object} args
 * @param {string} [args.requested]     explicit locale from the client
 * @param {string} [args.acceptLanguage] raw Accept-Language header
 * @param {string[]} args.enabled        locales this tenant has enabled
 * @param {string} args.fallback         the tenant's default locale
 */
export function resolveLocale({ requested, acceptLanguage, enabled, fallback }) {
  const allowed = (enabled ?? []).filter(isSupportedLocale);
  const pool = allowed.length ? allowed : [DEFAULT_LOCALE];

  if (requested && pool.includes(requested)) return requested;

  for (const candidate of parseAcceptLanguage(acceptLanguage)) {
    if (pool.includes(candidate)) return candidate;
  }

  if (fallback && pool.includes(fallback)) return fallback;
  return pool[0];
}

/**
 * "it-IT,it;q=0.9,en;q=0.8" -> ["it", "en"], highest quality first.
 * Region subtags are dropped: we translate by language, so it-CH and it-IT are
 * both "it".
 */
export function parseAcceptLanguage(header) {
  if (!header || typeof header !== "string") return [];

  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;
      return {
        language: tag.trim().split("-")[0].toLowerCase(),
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    .filter((entry) => entry.language && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => entry.language);
}
