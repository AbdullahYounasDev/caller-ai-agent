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

// ── a promise the system cannot keep ────────────────────────────────────────────────────────────────────────────
// Real calls (CLAUDE.md §6.26 / §6.24): with no request being taken, the agent asked a caller for a name, an address and a
// phone number and then said "I'll pass your order and details to our team; they'll contact you shortly" — nothing was
// saved, nobody was told. The only legitimate way to take details is a request the ENGINE has started (its reply then opens
// with a start marker, which this judge therefore treats as the legitimate path).
const MARKER = /\[\[\s*START/i;
// Asking for personal details of the caller.
// (Urdu words are delimited with Unicode-aware edges: \b does not see Arabic-script letters.)
const ASKS_FOR_DETAILS = /\b(your|a|the) (full |complete |delivery |street |contact |mobile |phone |home )*(name|number|address|e-?mail)\b|(?<![\p{L}\p{M}])(نام|نمبر|پتہ|پتا|ایڈریس)(?![\p{L}\p{M}])[^.!?۔؟]{0,25}(بتا|دے|دیں|بتائیں|بتائیے)/iu;
// Saying something was recorded, passed on or will be followed up.
const CLAIMS_DONE = /(?<!as )\bnoted\b|\b(i|we)('ll| will| can| could)? note (that|this|it|your \w+) down\b|\b(recorded|saved|logged|forwarded|passed (it |that |this |your \w+ )?on|taken down|written down|placed your order|booked)\b|\b(pass|passing|forward|forwarding|send|sending|hand|handing)\b[^.!?]{0,30}\b(order|details|request|information)\b[^.!?]{0,30}\b(to|on to|along to) (our |the )?(team|kitchen|staff|manager)|(team|staff|someone|kitchen)[^.!?]{0,25}\b(will|'ll|shall)\b[^.!?]{0,25}\b(contact|call|reach|confirm|get back)|نوٹ (کر|ہو)|محفوظ (کر|ہو)|ٹیم (آپ سے )?(جلد )?(رابطہ|کال)/i;
// …unless it is only an offer or a question ("would you like the team to call you?"). "I can note that down" is NOT an
// offer: it is the promise itself.
const IS_OFFER = /\b(if you|would you|do you want|want me to|shall i|let me know if)\b|[?؟]|کیا آپ|چاہیں تو/i;

// An explicit offer to take details ("would you like me to take your name?") is a question ABOUT asking, not the asking.
const OFFERS_TO_TAKE = /\b(would you like|do you want|want me to|shall i|if you('d| would) like)\b|چاہیں گے|چاہتے ہیں/i;

/**
 * Did the reply ask for personal details, or claim something was noted / passed on / will be followed up, with NO request
 * started by the engine (no start marker)? Judged per sentence: an offer or a question is not a claim.
 * @param {string} text
 * @returns {boolean}
 */
export const falsePromise = (text) => {
  if (MARKER.test(text)) return false;
  return text
    .split(/(?<=[.!?۔؟])\s+/)
    .some((sentence) => (ASKS_FOR_DETAILS.test(sentence) && !OFFERS_TO_TAKE.test(sentence)) || (CLAIMS_DONE.test(sentence) && !IS_OFFER.test(sentence)));
};
