import { CATALOGS, NAMESPACES } from "./catalogs";

/**
 * Minimal i18n. Key → string, with interpolation, CLDR plurals and RTL support.
 *
 * ── TWO SEPARATE LANGUAGES, DELIBERATELY ─────────────────────────────────
 * They are not the same setting and must never be collapsed into one:
 *
 *   UI LOCALE            what language the DASHBOARD is in — the language the
 *   (uiLocale)           business owner reads while configuring their agent.
 *                        Covers every namespace. Changing it changes the whole
 *                        interface, not one panel.
 *
 *   REPLY LANGUAGE       what language the AGENT SPEAKS to a customer: "en" or "ur".
 *   (replyLanguage)      Applied in prompt.js, never here. Whichever is chosen, the
 *                        agent UNDERSTANDS both English and Urdu (and the two mixed,
 *                        which is how people in Pakistan actually talk) and ANSWERS
 *                        in the one chosen.
 *
 * A business in Karachi may read its dashboard in English while its agent answers
 * callers in Urdu, or the reverse. One setting cannot express that.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY NOT next-intl / i18next: this is the whole system in one file, with no
 * provider tree, loader or plugin layer to learn. A framework-coupled library
 * would be more machinery than the problem needs.
 *
 * THE RULES:
 *   - `en` is the source of truth. Every other locale is measured against it.
 *   - A key missing from a locale falls back to `en` — never to a blank string,
 *     and never to the raw key, because someone seeing "chat.input.send"
 *     on screen is worse than seeing English.
 *   - Key parity is enforced by `npm run i18n:check`, so the fallback path
 *     should be unreachable in practice. It exists for the case where it isn't.
 */

/**
 * ACTIVE interface languages: English (the default and the source of truth) and
 * Urdu. These are the only two languages the product supports anywhere — the
 * dashboard, what the agent understands, what it answers in, and what it speaks.
 * Italian and Arabic were removed on purpose; do not bring them back piecemeal.
 */
export const SUPPORTED_LOCALES = ["en", "ur"];
export const DEFAULT_LOCALE = "en";

/**
 * Urdu is right-to-left. Direction is a DOCUMENT concern (see dirFor), and every
 * layout uses logical CSS properties (ms-/me-/ps-/pe-, start/end), so switching the
 * interface to Urdu flips the page without a separate stylesheet.
 */
export const RTL_LOCALES = ["ur"];

/**
 * What language the AGENT replies in. Distinct from the interface language.
 *
 *   "en"  always answer in English
 *   "ur"  always answer in Urdu
 *
 * Both settings UNDERSTAND both languages: a business that chose English still has
 * callers who speak Urdu, or mix the two mid-sentence, and the agent must follow
 * them and answer in the chosen language. There is no "mirror the caller" mode any
 * more — the business decides what its agent says (an older "auto" value is mapped
 * to the default by config.js).
 *
 * Neither value is a locale lookup problem: the reply language reaches the model as
 * an instruction in prompt.js, never `t()`. Spoken Urdu needs the voice stack of
 * §6.24 (Urdu speech recognition is hosted — Groq Whisper).
 */
export const REPLY_LANGUAGES = ["en", "ur"];
export const DEFAULT_REPLY_LANGUAGE = "en";

/** @param {unknown} value */
export function isReplyLanguage(value) {
  return typeof value === "string" && REPLY_LANGUAGES.includes(value);
}

/**
 * Everything a language switcher needs, anywhere in the system.
 *
 * `nativeName` is the language's name IN THAT LANGUAGE — "اردو", not
 * "Urdu". A switcher labelled in the language you currently can't read is
 * useless to the person who most needs it.
 */
export const LOCALE_META = SUPPORTED_LOCALES.map((code) => ({
  code,
  nativeName: CATALOGS[code].common[`language.${code}`],
  dir: RTL_LOCALES.includes(code) ? "rtl" : "ltr",
}));

/**
 * Every string for one language, as `{ namespace: { key: value } }`.
 *
 * This is how a frontend gets its whole interface in one request instead of
 * asking per key — the partner's dashboard calls `GET /api/locales/<code>` and
 * renders from what comes back. Add a key to the catalogs and it appears in his
 * UI with no change on his side.
 *
 * @param {string} locale
 * @param {string[]} [namespaces] defaults to all of them
 */
export function getCatalog(locale, namespaces = NAMESPACES) {
  const safeLocale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const out = {};

  for (const namespace of namespaces) {
    if (!NAMESPACES.includes(namespace)) continue;
    // Merged over English so a gap never reaches the client as a blank label.
    // `i18n:check` should make this unreachable; it's here for when it isn't.
    out[namespace] = {
      ...CATALOGS[DEFAULT_LOCALE][namespace],
      ...CATALOGS[safeLocale][namespace],
    };
  }

  return out;
}

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
 * @param {string} args.key  "namespace:key.path" — e.g. "dashboard:chat.send"
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
 *   const tr = translator("ur");
 *   tr("dashboard:chat.send");
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
 * gets almost every sentence wrong in languages with more forms. Urdu and English
 * have two. Letting Intl decide means each translator writes the forms their
 * own language actually has.
 */
function pluralKey(locale, path, count) {
  const category = new Intl.PluralRules(locale).select(count);
  return `${path}_${category}`;
}

/**
 * Replace {placeholders}, formatting numbers for the locale.
 *
 * ON URDU NUMERALS — a product decision, not a bug. Our locale codes have no
 * region, and CLDR formats bare "ur" with Latin digits (Pakistan writes prices and
 * phone numbers that way in practice). If a tenant ever needs Extended Arabic-Indic
 * numerals, the fix is a region-aware locale rather than hardcoding a numbering
 * system here.
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
 * that only operates in English must not get Urdu just because a visitor's
 * browser asked.
 *
 * @param {object} args
 * @param {string} [args.requested]     explicit locale from the client
 * @param {string} [args.acceptLanguage] raw Accept-Language header
 * @param {string[]} args.enabled        locales this tenant has enabled
 * @param {string} args.fallback         the tenant's default locale
 */
export function resolveLocale({ requested, acceptLanguage, enabled, fallback }) {
  // `enabled` UNDEFINED and `enabled` EMPTY mean opposite things, and conflating
  // them is a real bug this code already had once: every dashboard request
  // silently resolved to English because "no tenant restriction" was read as
  // "only English allowed".
  //
  //   undefined / null → unrestricted. Used for UI language, which isn't limited
  //                      by any business's customer-facing languages.
  //   []               → a tenant with nothing configured. Fall back to default.
  //   [..]             → exactly these.
  let pool;
  if (enabled === undefined || enabled === null) {
    pool = SUPPORTED_LOCALES;
  } else {
    const allowed = enabled.filter(isSupportedLocale);
    pool = allowed.length ? allowed : [DEFAULT_LOCALE];
  }

  if (requested && pool.includes(requested)) return requested;

  for (const candidate of parseAcceptLanguage(acceptLanguage)) {
    if (pool.includes(candidate)) return candidate;
  }

  if (fallback && pool.includes(fallback)) return fallback;

  // With an unrestricted pool, pool[0] would be whatever happens to sit first in
  // SUPPORTED_LOCALES — prefer the explicit default over list order.
  return pool.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : pool[0];
}

/**
 * "ur-PK,ur;q=0.9,en;q=0.8" -> ["ur", "ur", "en"], highest quality first.
 * Region subtags are dropped: we translate by language, so en-GB and en-US are
 * both "en".
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
