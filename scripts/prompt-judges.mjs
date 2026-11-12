/**
 * THE JUDGES OF `npm run prompt:probe` — "did this reply do the bad thing?" — kept apart from the probe so
 * tests/prompt-judges.test.mjs can pin them. A judge that mis-scores silently corrupts every number built on it
 * (the first versions of these mis-scored both ways and were corrected by reading the samples, CLAUDE.md §6.24
 * "Found on those calls"); change one only with a sample that shows the mistake, and add that sample to the test.
 *
 * They are regular expressions calibrated on Groq gpt-oss-120b's wording in English and Urdu script. They are a
 * measuring instrument for A/B comparisons of a prompt, not a proof about any other model.
 */

/** The spoken "first… then…" habit: "First," as a sentence opener anywhere in the reply. */
export const firstHabit = (t) => /(^|[.!?]\s+|^\W*)first(ly)?\s*,/i.test(t);

const BRAND = /Nyron Software Solutions|Nyron Software|Nyron|نیئرون|نائرون|نیرون/gi;
const NEGATION = /don['’]?t have|do not have|no (detailed )?information|not (been )?(given|told|provided)|can['’]?t say|unable to|not sure|معلومات نہیں|معلومات موجود نہیں|نہیں ہیں|نہیں ہے|نہیں بتا|دستیاب نہیں/i;
// Words that describe WHAT a business does. A business told only its name has no business saying any of them.
const DOMAIN = /software|technolog|\bsolutions?\b|\bIT\b|سافٹ\s*ویئر|ٹیکنالوجی|تکنیکی|\bحل\b/i;
const CLAIM_VERB = /\b(provide|provides|providing|create|creates|deliver|delivers|develop|develops|design|designs|build|builds|offer|offers|specialis\w+|help(s)? (businesses|companies|clients|customers with))\b|تیار کر|ڈیزائن|بناتے/i;

/**
 * Did the reply invent a description of the business? Judged per sentence, with the business's own name
 * removed first (the name is allowed to say "Software"), and an honest "I don't have that" never counts.
 * The brand list is the name-only test agent's ("Nyron …"): point it at another name before using it elsewhere.
 */
export const inventedDescription = (text) =>
  text
    .split(/(?<=[.!?۔؟])\s+/)
    .some((s) => {
      if (NEGATION.test(s)) return false;
      const rest = s.replace(BRAND, " ");
      return DOMAIN.test(rest) || (CLAIM_VERB.test(rest) && /\b(we|our)\b|ہم|ہمار/i.test(rest));
    });

/**
 * Over-refusal: an agent that WAS told what the business does must not say it does not know.
 * ("not been provided / given / told" was added after the 18/18 measurement of §6.24, when the test below showed the
 * gap; it can only flag MORE, so that measurement's "0 refusals" still stands.)
 */
export const refusesToDescribe = (t) => /don['’]?t have|do not have|not (been )?(provided|given|told)|can['’]?t say|معلومات (موجود )?نہیں|تفصیل(ات)? (موجود |دستیاب )?نہیں|دستیاب نہیں/i.test(t);
